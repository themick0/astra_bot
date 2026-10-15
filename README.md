# Astra Bot

Fastify service for a Telegram moderation bot and a restricted AI assistant.

## Local development

Requirements: Node.js 22+ and Corepack-enabled pnpm.

```bash
cp .env.example .env
corepack pnpm install
corepack pnpm db:generate
# Fill in .env, then start the local database (or use your own PostgreSQL).
docker compose up -d --wait
corepack pnpm db:migrate
corepack pnpm dev
```

Set `TELEGRAM_BOT_TOKEN`, `OWNER_USERNAME`, `OPENAI_API_KEY`, and
`DATABASE_URL` in `.env`. Set `ALLOWED_CHAT_ID` to one or more negative Telegram group IDs separated by commas (for example,
`-1001234567890,-1009876543210`) for a private group, or `ALLOWED_CHAT_USERNAME` for a public supergroup.
If both are set, the ID list takes precedence. A single ID remains supported.
`/ask`, replies, and mentions in groups write `Telegram assistant request received` with `chatId`
before access checks, including groups not yet allowed. Question text is not logged.
Adding the bot to a group or changing its membership writes `Telegram bot chat membership changed`
to the server log with `chatId`, even for groups outside the allowlist.
`/chatid` from a group administrator replies with its numeric ID and writes `chatId` to the server log,
including groups not yet in the allowlist. Add the returned ID to `ALLOWED_CHAT_ID` and restart.
In groups, assistant tools are scoped to the current chat and topic. When several groups are configured,
owner-private tool calls require an explicit allowed `chat_id`; specify the group in your request. For the local Compose database, also set `POSTGRES_PASSWORD` and use
`postgresql://astra:<your-url-encoded-password>@localhost:5432/astra` as `DATABASE_URL`.
For an existing PostgreSQL instance, Compose is optional. Migrations create new memory tables;
`db:migrate` applies the checked-in migration and does not reset the database.
`OPENAI_MODEL` defaults to `gpt-6-luna` and must name a model available to your OpenAI project.

The HTTP surface exposes `GET /health`, `GET /ready`, and `GET /me` on port `3000`.
Usernames can be entered with or without `@`; comparisons ignore case. Groups without a public username are authorized by ID.
Telegram uses long polling. Only current administrators of the configured group can ask via `/ask <question>`,
a text reply to the bot's own message, or a Telegram @mention of the bot. A mention by Telegram user
ID is also supported. The bot stays silent on unaddressed messages and ignores unrelated commands.
Messages containing Astra/Астра or a name inflection first pass a semantic address check using
`OPENAI_MODEL`. A direct question/greeting such as “Астра, что думаешь?” or “Вопрос к Астре…” can
trigger a response; discussion about Astra, quoted speech, flowers and product names should not.
Names in code, links, Telegram quotes or forwarded messages do not trigger this check. Ambiguity,
provider errors, lack of access and overload remain silent. The check shares the normal request
limits and shutdown lifecycle; it uses only the current text and up to 1200 characters of a same-topic
quoted reply, with a 10-second timeout, 512 output tokens and no retries. It is an AI judgment,
so occasional misclassification is possible; /ask and @mentions remain explicit triggers.
After a successfully delivered assistant answer, an active conversation window lasts two minutes
in that chat/topic. Any current administrator may continue without a tag if a separate intent check confirms
they are addressing Astra. The check sees up to six recent turns with speaker IDs (600 characters
each); human-to-human messages do not renew the window. Ambiguity/errors remain silent, closing
acknowledgments close the window, and tools/permissions are rebuilt for the current author.
The window is kept only in process memory, bounded to 64 scopes with lazy expiry; it is cleared on
restart, shutdown or an authorized `/reset`. Failed answer delivery does not open it. Continuation
checks share assistant job limits, with a 10-second timeout, 512 output tokens and no retries.
They do not receive private data from other chats, and each new answer still passes access checks.
Assistant requests receive the current background moderation setting independently of chat history.
Search tools return a filtered sample of up to three messages received by the bot in the current topic;
they cannot establish that other messages are absent or import Telegram history from before observation.
These entry points share conversation memory, duplicate-update protection, and request limits.
Private assistant access remains limited to the configured owner; bots and anonymous senders cannot
use the assistant. Administrator status is checked before analysis and before each answer chunk.
Ordinary members are silently ignored, including `/ask`, replies, mentions, name addresses and
continuations; no conversational AI or intent detection runs for them. `/ping` and `/reset` are also
restricted, while background moderation and group memory capture continue for all participants.
Assistant answers longer than 1000 UTF-16 units or at least 12 lines (including blank lines)
are sent as expandable Telegram quotes. Answers exceeding the message chunk size are split,
with each chunk quoted when the full answer meets either threshold.
Conversation requests produce text only and cannot perform bans or message deletions.
Backend tools are role-scoped. Current administrators can use `get_chat_info`,
`get_chat_member_count`, `get_my_profile`, and (with a moderation store) `search_my_messages`.
Self tools bind the target to the trusted Telegram caller; model-supplied user IDs are rejected.
`get_member_info`, `search_messages`, and `request_moderation_review` are administrator-only;
read-only inspections remain available to administrators independently of enforcement being enabled.
Group tools stay in the current chat/topic; the private owner must select an allowed group when
several are configured and must hold administrator status there for inspecting others.
Membership and administrator rights are checked on each call, after fetching restricted data,
and before each answer chunk containing administrator-tool results. Self-service searches return
only the caller's messages. The model is instructed to decline targeted investigations of others
from members naturally, including attempts to reconstruct them from conversation history.
Ordinary discussion of public chat topics is currently available only to administrators. Telegram tools do not expose private
conversations, phone numbers, hidden profile data, or account age.
`/reset` is restricted separately to group administrators and the private-chat owner.
Requests time out after 60 seconds,
accept up to 8000 input characters, and generate up to 2048 output tokens. Up to eight requests run in the background, with one active request per conversation and
one pending question per user in a chat. Access is checked before each answer chunk. Shutdown waits
for active requests before closing memory and the database. Long answers are sent as plain text in multiple replies.
Provider response storage is disabled, and request/response contents are not logged.

## VPS deployment

Production uses [Dockerfile](Dockerfile), [production Compose](deploy/compose.yaml), and
[GitHub Actions](.github/workflows/deploy.yaml). GitHub builds Linux amd64 application and migration
images in GHCR, tagged with the full commit SHA. Pushes to `main` and manual workflow runs on `main`
deploy after `pnpm check` passes. The VPS does not build code. The existing root Compose remains
the local development database.

### Prepare the VPS once

Use Ubuntu 24.04 and install Docker Engine plus the Compose plugin using the
[official instructions](https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository).
The following commands run on the VPS as root:

```bash
apt-get update
apt-get install -y rsync util-linux openssl
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -o deploy -g deploy -m 700 /opt/astra-bot
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
```

Generate a dedicated deployment key on your computer:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/astra-deploy -C astra-deploy
```

For unattended Actions, leave this dedicated key's passphrase empty. Put its public key in
`/home/deploy/.ssh/authorized_keys` on the VPS; set owner `deploy:deploy` and permissions `600`.
The Docker group grants root-equivalent access, so keep this key restricted to deployment.
Test login from your computer with `ssh -i ~/.ssh/astra-deploy deploy@YOUR_VPS_IP`.

Copy [the production env example](deploy/.env.example) to `/opt/astra-bot/.env` on the VPS and
fill it in using an editor there. Run `openssl rand -hex 24` to generate the database password.
Set the same value in `POSTGRES_PASSWORD` and in `DATABASE_URL`; the hex password needs no URL
escaping. Use host `postgres`, not `localhost`, in the URL. Set `.env` permissions to `600`.
Keep the bot tokens and database credentials on the VPS, outside Git and Docker images.
Do not change `POSTGRES_PASSWORD` after database initialization without also changing the database
role password; changing the env file alone does not rotate an existing database password.

Actions pulls private GHCR images using its short-lived `GITHUB_TOKEN`, sent through SSH and stored
in a temporary Docker configuration removed after deployment. No registry PAT is needed for Actions.
For manual deployments that pull images, as `deploy`, log in to GHCR with a GitHub classic PAT with `read:packages`
and access to this repository's packages (authorize organization SSO if applicable):

```bash
read -rsp 'GHCR read token: ' ghcr_token
printf '\n'
printf '%s' "$ghcr_token" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
unset ghcr_token
```

Keep SSH accessible in the provider firewall. The database has no published port, and HTTP is bound
to `127.0.0.1:3000`. Telegram long polling needs outbound HTTPS; no domain or reverse proxy is required.
On a 1 GB VPS, a small swap file can help with short memory spikes; monitor memory and disk usage.

### Configure GitHub and deploy

In repository Settings → Secrets and variables → Actions, add these repository secrets:

| Secret               | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| `DEPLOY_HOST`        | VPS IPv4 address or hostname                                |
| `DEPLOY_USER`        | `deploy`                                                    |
| `DEPLOY_SSH_KEY`     | Contents of the dedicated private key `~/.ssh/astra-deploy` |
| `DEPLOY_KNOWN_HOSTS` | Verified SSH host-key entry for the VPS                     |

On your computer, obtain the candidate host key with `ssh-keyscan -t ed25519 YOUR_VPS_IP`.
Compare its fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run through the
provider's trusted console before saving the entry in `DEPLOY_KNOWN_HOSTS`. The workflow verifies
this key rather than disabling SSH host verification. It currently uses SSH port 22.

Enable GitHub Actions if disabled. Commit these deployment files and push to `main`, or select
Actions → Deploy → Run workflow on `main`. The workflow publishes the images, copies the deployment
scripts and Compose file to `/opt/astra-bot`, then runs [deploy.sh](deploy/deploy.sh).
Stop any other instance using this Telegram bot token, including your local development process.

If `/home/deploy/.ssh/github-actions` has already been generated on the VPS and authorized for
the `deploy` user, [configure-github.sh](deploy/configure-github.sh) can set the four repository
secrets directly from your computer, without displaying the private key. Authenticate with
`gh auth login` first, verify the VPS host key, then run
`bash deploy/configure-github.sh YOUR_VPS_IP YOUR_OWNER/YOUR_REPO`.
This sets repository deployment secrets and requires permission to manage repository secrets.
Repository secrets also work with private repositories on GitHub Free; deployment environments
would require a paid plan for private repositories.
Actions handles GHCR authentication automatically; manual registry deployments need the login above.

For a first deployment without GHCR access, build both targets on your computer with
`--platform linux/amd64` and tag them with the same full commit SHA and `-migrate` suffix.
Transfer them using `docker save ... | gzip | ssh deploy@YOUR_VPS_IP 'gunzip | docker load'`,
copy the production Compose and scripts to `/opt/astra-bot`, then run
`bash deploy.sh ghcr.io/YOUR_OWNER/YOUR_REPO:FULL_COMMIT_SHA --loaded-images` on the VPS.
This mode requires both images to be present locally; only PostgreSQL is pulled.

Each deployment downloads images before stopping the bot, waits for PostgreSQL, stops the existing
poller, makes a database dump, applies migrations, and starts one bot container. Commands are serialized
by an on-server lock. The bot has a 120-second shutdown grace period and restarts after host reboot.
The health check verifies HTTP startup, not ongoing Telegram polling or OpenAI availability.
If a migration or startup fails, Actions fails and the bot remains stopped; inspect the failure
before restarting anything.
No automatic schema rollback or old-version restart is attempted after migrations.

As `deploy` on the VPS, inspect the current successful release:

```bash
cd /opt/astra-bot
set -a
source .release.env
set +a
docker compose ps
docker compose logs --tail 100 bot
curl --fail http://127.0.0.1:3000/health
```

`.release.env` records `ASTRA_IMAGE` and `PREVIOUS_ASTRA_IMAGE` only after a healthy deployment.
The previous image is the last different successfully deployed release; redeploying the same SHA
does not replace it. Existing state files containing only `ASTRA_IMAGE` are supported.
If the first deployment fails, set
`export ASTRA_IMAGE=ghcr.io/YOUR_OWNER/YOUR_REPO:FULL_COMMIT_SHA` from the failed Actions run before
using Compose. To retry a release, run `bash deploy.sh "$ASTRA_IMAGE"`.
An older application image can be redeployed only if it is compatible with the current schema.
Never use `docker compose down -v` on production: it deletes the database volume.

### Backups and disk space

Each deployment writes a private PostgreSQL custom-format dump under `/opt/astra-bot/backups`.
For daily local backups, run `crontab -e` as `deploy` and add:

```cron
15 3 * * * /bin/bash /opt/astra-bot/backup.sh
```

[backup.sh](deploy/backup.sh) keeps approximately seven days of daily dumps; deployment dumps remain
until manually removed. Copy dumps to your computer or separate storage regularly: local dumps alone
do not protect against VPS loss. A computer-side download can use:

```bash
rsync -av -e 'ssh -i ~/.ssh/astra-deploy' deploy@YOUR_VPS_IP:/opt/astra-bot/backups/ ./astra-backups/
```

Treat dumps as private chat data. Test restoration into a separate database with `pg_restore` before
relying on them. Container logs are rotated. Monitor `df -h` and `docker system df`.

After each successful deployment, the deploy script retains the current and previous distinct
successful releases, including both `-migrate` images. It removes other full-SHA release tags only
from the deployed Astra image repository. Images referenced by running or stopped containers are
also retained. On the first-ever deployment, only the current release is known and retained.
Cleanup runs under the deployment lock after the health check and atomic release-state update;
failed deployments do not trigger it. Cleanup errors produce a warning without failing a healthy
deployment and are retried on the next successful deploy.

This cleanup does not remove database volumes, backups, build cache, other repositories, or GHCR
images. Keep enough disk space to download a new release before cleanup; if the disk is already
full, remove selected obsolete images manually while preserving the current release and its migration
image. Keeping an older image does not guarantee its compatibility with the current database schema.

## Conversation memory

PostgreSQL stores `Conversation`, `Message`, and `ConversationSummary` through Prisma 7.
The runtime requires migrated tables; it connects and checks cleanup before starting Telegram polling.
Generate the Prisma client after installing dependencies with `pnpm db:generate` (build also generates it).

Ordinary text received in the allowed group and the owner's private chat contributes to context.
Each group topic has separate shared memory; private chats are isolated by Telegram chat ID.
Other chats are ignored. Commands other than `/ask` are excluded. The bot also handles `/ping` and `/reset`.
Group members' text contributes shared context; only current administrators can address the assistant.
For ordinary group messages to reach the bot, make it a group administrator or disable privacy mode
in BotFather. Memory starts with updates the bot receives; this implementation does not import earlier
Telegram history. Edited messages, attachments, and messages from other bots are not collected.

Each request includes an existing summary, recent messages with author attribution, and a quoted
reply when present. Recent context is limited to 12,000 UTF-8 bytes, summaries to 3,000 bytes, and
individual stored messages to 8,000 bytes. These are conservative size limits, not exact token counts;
long messages are truncated without breaking Unicode. At most 60 recent rows are read per request.
Instructions for Astra are separate from the untrusted conversation context.

Summarization runs in the background once unsummarized history reaches 40 messages or exceeds the
recent-context byte budget. It keeps up to 12 recent messages verbatim, summarizes bounded batches,
and starts at most one job per conversation every 30 seconds. Backlogs and failed jobs are retried
while the process is running. Globally, at most two summary jobs run with up to 64 conversations queued.
When the queue is full, additional scheduling is dropped until a later refresh; stored messages remain
available. Shutdown discards queued jobs and waits for active summaries. Summary generation uses `OPENAI_MODEL`; it incurs an additional API
request only when compaction is needed. `/ask` uses the currently available summary without waiting.
One polling process is supported; summary versions prevent stale database writes, but running multiple
bot processes is not supported.

`/reset` clears the current chat/topic's messages and summary; group administrators can reset shared
topic memory, and the owner can reset private memory. Reset is rejected while any assistant request is
active in the conversation. Raw messages expire after seven days, with
cleanup at startup and hourly. Summaries remain while a conversation is active; conversations idle
for seven days are deleted. Deleted or edited Telegram messages are not automatically reconciled.
A summary can omit details; recent verbatim messages remain the source for exact wording.

Run database integration tests against a dedicated, migrated test database:

```bash
TEST_DATABASE_URL=<test-postgresql-url> corepack pnpm test
```

Without `TEST_DATABASE_URL`, the database integration test is skipped; unit and Telegram tests run.

## Moderation with owner confirmation

Moderation is disabled by default. Set `MODERATION_ENABLED=true` and `OWNER_USERNAME` to your Telegram username, apply migrations with `pnpm db:migrate`, and send `/start` to the bot
in a private chat. The owner must be an administrator with permission to restrict members of the
configured group. Make the bot a group administrator with ban permissions so it receives group
messages and can execute confirmed bans. `PROTECTED_USER_IDS` optionally lists comma-separated
numeric IDs excluded from both suggested and confirmed bans. At startup the bot resolves
`OWNER_USERNAME` from Telegram administrators of the allowed groups and pins the numeric ID for
private notifications, assistant access, and confirmations. No `OWNER_USER_ID` configuration is needed.
The owner must be found in at least one allowed group; missing or conflicting identities fail startup.
After changing the owner username, update the configuration and restart the service.

Text messages, captions, and their received edits in the configured group are analyzed for unsolicited
advertising and suspicious promotion, including USDT offers and service advertisements disguised as
recommendations in comments. AI receives only group evidence: the current message, quoted reply,
up to 12 earlier messages by the same author across this group's topics, and observed message counts.
Missing history does not establish a new account: Telegram does not expose an account creation date.
History begins when moderation is enabled; existing conversation memory is not imported.
The classifier distinguishes `clean`, `spam` (strong spam-like text/pattern, not proof of bot identity),
`advertising`, `suspicious`, and `community_event` (creative event requiring owner coordination).
Creative workshops, exhibitions, jams and similar invitations are not ban/deletion grounds merely
because they contain a price, registration link or polished wording. Prior genuine non-promotional
conversation reduces suspicion; the explanation must discuss that evidence or missing history.
Event and ambiguous reviews explicitly avoid recommending punishment and put **Keep without sanctions**
first. The owner can still explicitly choose a permanent ban with message deletion. No category
authorizes automatic enforcement, and AI classification can be wrong.

Suspicious cases produce a private notification with an excerpt, a source link where available,
the AI explanation, and **Ban permanently** / **Keep** buttons. No automatic bans, mutes, or message
deletions are performed. A confirmed permanent ban uses Telegram's `banChatMember` with
`revoke_messages: true`, deleting only the banned participant's messages across this group.
After the successful ban is saved, Astra separately removes the source message when Telegram permits
it and reports the result only to the owner in private chat. Cleanup failures are reported without
claiming deletion or retrying the ban. No ban announcements are posted to the group or generated by AI.
Administrators, the owner, and configured
protected users cannot be recommended for a ban or banned. Actor permissions and target protection
are checked again immediately before the Telegram action. Anonymous/channel senders are excluded
because they cannot be safely treated as user accounts.

Decisions and pending reviews persist independently of `/reset`. Repeated updates and clicks do not
repeat bans. Received edits invalidate older reviews of that message. At most one active review is
sent per participant in a group; subsequent suspicious messages are recorded while that review is
pending. Reviews expire after seven days. On restart, unfinished analyses resume; ambiguous notification
or ban delivery is recorded as `unknown` and is never automatically repeated. A failed/ambiguous
notification may require manual inspection of the database; it does not authorize a ban.

Two analyses run concurrently with up to 64 queued/running cases. Queue overflow is recorded as
`overloaded` and is not analyzed or acted on. Each received eligible message can incur an OpenAI
request using `OPENAI_MODEL`; classification failures are retried up to three attempts. The queue is
checked every five seconds. Only one polling process is supported. Message text, reply text, author
labels, and classification explanations are removed after seven days by startup/hourly cleanup;
numeric participant IDs, first-observed dates, counts, and decision metadata remain for audit.
The current version has no statistics command or automated enforcement mode. Classification quality
must be assessed from real review decisions; mock tests cannot establish detection accuracy.

## Commands

- `pnpm dev` — run with reload.
- `pnpm build && pnpm start` — build and run production output.
- `pnpm db:generate` — generate the Prisma client.
- `pnpm db:migrate` — apply checked-in PostgreSQL migrations.
- `pnpm db:dev` — create a migration during development.
- `pnpm check` — typecheck, lint, formatting, tests, and agent-harness audit.
- `pnpm audit:agents` — check generated indexes, Markdown links, and local paths/links in source
  comments. External URLs and prose accuracy are not checked automatically.
- `pnpm sync:agents` — rebuild the rule and skill indexes in `AGENTS.md` from `ai/`.

Agent navigation starts in [AGENTS.md](AGENTS.md). Product and safety context lives in
[AGENT_CONTEXT.md](AGENT_CONTEXT.md).
