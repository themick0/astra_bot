import type {
  CaseChange,
  Classify,
  Evidence,
  ModerationStore,
  Observation,
  ReviewCase,
} from "@app/modules/moderation/types";

export type Eligibility = "allowed" | "protected" | "denied";

export interface ModerationActions {
  eligibility(item: ReviewCase): Promise<Eligibility>;
  notify(item: ReviewCase): Promise<number | undefined>;
  ban(item: ReviewCase, current: () => Promise<boolean>): Promise<Eligibility>;
  removeBannedMessage?(item: ReviewCase): Promise<boolean>;
  deleteMessage?(item: ReviewCase, current: () => Promise<boolean>): Promise<Eligibility>;
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function buildEvidence(item: ReviewCase, history: readonly string[]): Evidence {
  return {
    text: item.text,
    replyText: item.replyText,
    isBot: item.isBot,
    firstSeenAt: item.firstSeenAt.toISOString(),
    observedMessageCount: item.messageCount,
    previousMessages: history.slice(-12).map((text) => [...text].slice(0, 600).join("")),
    exactRepeats: history.filter((text) => normalize(text) === normalize(item.text)).length,
  };
}

export function createModeration(
  store: ModerationStore,
  classify: Classify,
  actions: ModerationActions,
  ownerUserId: number | (() => number | undefined),
) {
  const jobs = new Map<string, Promise<void>>();
  const decisions = new Set<Promise<string>>();
  let pumping: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing = false;

  async function transition(item: ReviewCase, status: string, change?: CaseChange) {
    const changed = await store.transition(item.id, item.status, status, change);
    if (changed) {
      item.status = status;
      console.info("Moderation case updated", {
        caseId: item.id,
        chatId: item.chatId.toString(),
        messageId: item.messageId,
        status,
        category: change?.category ?? item.category,
      });
    }
    return changed;
  }

  async function analyze(item: ReviewCase): Promise<void> {
    try {
      if (!(await store.claimAnalysis(item.id))) return;
      item.status = "analyzing";
      item.attempts += 1;
      if (!item.text.trim()) {
        await transition(item, "clean");
        return;
      }
      const eligibility = await actions.eligibility(item);
      if (eligibility !== "allowed") {
        await transition(item, eligibility === "protected" ? "protected" : "failed");
        return;
      }
      const evidence = buildEvidence(item, await store.history(item));
      const result = await classify(evidence);
      if (result.category === "clean") {
        await transition(item, "clean", result);
        return;
      }

      // A promotion or protection change during AI analysis invalidates a suggested ban.
      const rechecked = await actions.eligibility(item);
      if (rechecked !== "allowed") {
        await transition(item, rechecked === "protected" ? "protected" : "failed");
        return;
      }
      if (!(await store.isCurrent(item))) {
        await transition(item, "expired");
        return;
      }
      if (await store.hasOpenReview(item)) {
        await transition(item, "covered", result);
        return;
      }
      if (!(await transition(item, "notifying", result))) return;
      item.category = result.category;
      item.reason = result.reason;
      const notificationMessageId = await actions.notify(item);
      if (notificationMessageId === undefined) {
        await transition(item, "failed");
        return;
      }
      await transition(item, "review", { notificationMessageId });
    } catch {
      console.error("Moderation analysis or notification failed", { caseId: item.id });
      if (item.status === "analyzing") {
        await transition(item, item.attempts < 3 ? "queued" : "failed", {
          availableAt: new Date(Date.now() + 30_000 * item.attempts),
        });
      } else if (item.status === "notifying") {
        await transition(item, "unknown");
      }
    }
  }

  function runPending(): Promise<void> {
    if (closing || jobs.size >= 2) return Promise.resolve();
    pumping ??= (async () => {
      const queued = await store.queued(2 - jobs.size);
      for (const item of queued) {
        if (closing || jobs.has(item.id)) continue;
        const job = analyze(item)
          .catch(() => console.error("Moderation persistence failed", { caseId: item.id }))
          .finally(() => jobs.delete(item.id));
        jobs.set(item.id, job);
      }
    })().finally(() => {
      pumping = undefined;
    });
    return pumping;
  }

  async function decide(
    id: string,
    actorId: number,
    notificationMessageId: number,
    action: "ban" | "delete" | "keep",
  ): Promise<string> {
    const ownerId = typeof ownerUserId === "function" ? ownerUserId() : ownerUserId;
    if (closing || ownerId === undefined || actorId !== ownerId)
      return "Это действие доступно только владельцу.";
    const item = await store.get(id);
    if (!item || item.notificationMessageId !== notificationMessageId) {
      return "Заявка не найдена или сообщение не совпадает.";
    }
    if (item.status !== "review") return "Заявка уже обработана или недоступна.";
    if (action !== "keep" && action !== (item.action ?? "ban")) {
      return "Действие не соответствует заявке.";
    }
    if (item.expiresAt.getTime() <= Date.now() || !(await store.isCurrent(item))) {
      await transition(item, "expired");
      return "Заявка устарела. Бан не выполнен.";
    }
    const decision = { decidedBy: BigInt(actorId), decidedAt: new Date() };
    if (action === "keep") {
      return (await transition(item, "kept", decision))
        ? "Оставила участника. Ограничения не применялись."
        : "Заявка уже обработана.";
    }
    if (!(await transition(item, action === "delete" ? "deleting" : "banning", decision))) {
      return "Заявка уже обработана.";
    }

    try {
      // The adapter re-authorizes the owner and re-checks target protection right before banning.
      if (!(await store.isCurrent(item))) {
        await transition(item, "expired");
        return "Сообщение изменилось. Бан не выполнен.";
      }
      const current = async () =>
        (await store.isCurrent(item)) && item.expiresAt.getTime() > Date.now();
      const outcome =
        action === "delete"
          ? ((await actions.deleteMessage?.(item, current)) ?? "denied")
          : await actions.ban(item, current);
      if (outcome !== "allowed") {
        await transition(item, outcome === "protected" ? "protected" : "failed");
        return "Действие недоступно: участник защищён, срок удаления истёк или права изменились.";
      }
      if (!(await transition(item, action === "delete" ? "deleted" : "banned"))) {
        return "Telegram подтвердил действие, но статус заявки изменился. Проверь результат; повторно действие не отправляю.";
      }
    } catch {
      console.error("Moderation action outcome uncertain", { caseId: item.id });
      await transition(item, "unknown");
      return "Не удалось подтвердить результат. Проверь сообщение или статус участника в Telegram; повторное действие не отправляю.";
    }

    if (action === "delete") return "Сообщение удалено.";
    // The ban is durable before cleanup; deletion failure must not turn it into an uncertain ban.
    let messageRemoved = false;
    try {
      messageRemoved = (await actions.removeBannedMessage?.(item)) ?? false;
    } catch {
      console.warn("Moderation banned message removal failed", { caseId: item.id });
    }
    console.info("Moderation banned message removal completed", {
      caseId: item.id,
      confirmed: messageRemoved,
    });
    const confirmation = messageRemoved
      ? "Готово: участника забанила навсегда, исходного сообщения в чате больше нет."
      : "Участника забанила навсегда. Удаление исходного сообщения подтвердить не удалось — проверь его в чате.";
    return confirmation;
  }

  async function requestReview(
    id: string,
    actorId: number,
    action: "ban" | "delete",
    reason: string,
    authorize: () => Promise<boolean>,
  ): Promise<string> {
    if (closing || !(await authorize())) return "access_denied";
    const item = await store.get(id);
    if (
      !item ||
      !item.text.trim() ||
      item.expiresAt.getTime() <= Date.now() ||
      !(await store.isCurrent(item))
    ) {
      return "source_unavailable";
    }
    if (["notifying", "review", "banning", "deleting"].includes(item.status))
      return "already_pending";
    if (
      !["queued", "analyzing", "clean", "failed", "covered", "overloaded"].includes(item.status)
    ) {
      return "already_processed";
    }
    item.action = action;
    if ((await actions.eligibility(item)) !== "allowed") return "target_protected_or_unavailable";
    if (await store.hasOpenReview(item)) return "already_pending";
    if (!(await authorize())) return "access_denied";

    try {
      if (
        !(await transition(item, "notifying", {
          action,
          requestedBy: BigInt(actorId),
          category: "manual",
          reason,
        }))
      )
        return "already_processed";
      item.requestedBy = BigInt(actorId);
      item.category = "manual";
      item.reason = reason;
      if (!(await authorize()) || !(await store.isCurrent(item))) {
        await transition(item, "failed");
        return "access_or_source_changed";
      }
      const notificationMessageId = await actions.notify(item);
      if (notificationMessageId === undefined) {
        await transition(item, "failed");
        return "target_protected_or_unavailable";
      }
      return (await transition(item, "review", { notificationMessageId }))
        ? "pending_owner_confirmation"
        : "source_changed";
    } catch {
      console.error("Manual moderation review failed", { caseId: item.id });
      if (item.status === "notifying") await transition(item, "unknown");
      return "delivery_unconfirmed";
    }
  }

  function trackDecision(work: Promise<string>): Promise<string> {
    const tracked = work.finally(() => decisions.delete(tracked));
    decisions.add(tracked);
    return tracked;
  }

  return {
    async observe(input: Observation) {
      if (closing) return;
      await store.observe(input);
      void runPending().catch(() => console.error("Moderation queue read failed"));
    },
    runPending,
    decide(
      id: string,
      actorId: number,
      notificationMessageId: number,
      action: "ban" | "delete" | "keep",
    ) {
      return trackDecision(decide(id, actorId, notificationMessageId, action));
    },
    requestReview(
      id: string,
      actorId: number,
      action: "ban" | "delete",
      reason: string,
      authorize: () => Promise<boolean>,
    ) {
      return trackDecision(requestReview(id, actorId, action, reason, authorize));
    },
    async start() {
      if (timer || closing) return;
      await store.recover();
      await store.prune();
      await runPending();
      timer = setInterval(() => {
        void runPending().catch(() => console.error("Moderation queue read failed"));
      }, 5000);
      timer.unref();
    },
    async wait() {
      await pumping;
      await Promise.all(jobs.values());
      await Promise.allSettled(decisions);
    },
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      await pumping;
      await Promise.all(jobs.values());
      await Promise.allSettled(decisions);
    },
    prune: () => store.prune(),
  };
}

export type Moderation = ReturnType<typeof createModeration>;
