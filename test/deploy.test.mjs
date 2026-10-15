import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const repository = "ghcr.io/example/astra";
const release = (character) => `${repository}:${character.repeat(40)}`;
const current = release("a");
const previous = release("b");
const older = release("c");
const state = (active, prior = "") => `ASTRA_IMAGE=${active}\nPREVIOUS_ASTRA_IMAGE=${prior}\n`;
const image = (reference, id = reference.split(":")[1]) => {
  const separator = reference.lastIndexOf(":");
  return `${reference.slice(0, separator)} ${reference.slice(separator + 1)} sha256:${id}`;
};
const images = [current, previous, older].flatMap((reference) => [
  image(reference),
  image(`${reference}-migrate`),
]);

// Execute the real deployment script with only Docker and flock replaced.
// No daemon, registry, credentials, or production database is accessed.
function deploy(t, options = {}) {
  const directory = mkdtempSync(path.join(root, "ai/dev/deploy-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  copyFileSync(path.join(root, "deploy/deploy.sh"), path.join(directory, "deploy.sh"));
  writeFileSync(path.join(directory, ".env"), "# synthetic test configuration\n");
  if (options.state !== undefined) {
    writeFileSync(path.join(directory, ".release.env"), options.state);
  }
  writeFileSync(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
const options = JSON.parse(process.env.DEPLOY_TEST_OPTIONS);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
if (options.fail && args.join(" ").startsWith(options.fail)) process.exit(1);
if (args[0] === "image" && args[1] === "ls") {
  console.log(options.images.join("\\n"));
}
if (args[0] === "ps" && options.usedIds.length) console.log("container-one\\ncontainer-two");
if (args[0] === "container" && args[1] === "inspect") console.log(options.usedIds.join("\\n"));
if (args[0] === "image" && args[1] === "rm") {
  fs.appendFileSync("cleanup-state.txt", fs.readFileSync(".release.env"));
}
`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    "bash",
    [path.join(directory, "deploy.sh"), options.release ?? current, ...(options.args ?? [])],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        DEPLOY_TEST_OPTIONS: JSON.stringify({ images, usedIds: [], ...options }),
      },
    },
  );
  assert.ifError(result.error);
  const read = (file) => {
    try {
      return readFileSync(path.join(directory, file), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  };
  const calls = read("calls.jsonl")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    ...result,
    calls,
    state: read(".release.env"),
    cleanupState: read("cleanup-state.txt"),
    removed: calls.filter(([command, action]) => command === "image" && action === "rm"),
  };
}

test("healthy deployment keeps the two successful release pairs and cleans only Astra SHA tags", (t) => {
  const result = deploy(t, {
    state: state(previous, older),
    images: [
      ...images,
      image("postgres:17-alpine"),
      image(`ghcr.io/example/another:${"d".repeat(40)}`),
      image(`${repository}:latest`),
      image(`${repository}:<none>`),
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, state(current, previous));
  assert.deepEqual(result.removed, [
    ["image", "rm", older],
    ["image", "rm", `${older}-migrate`],
  ]);
  assert.equal(result.cleanupState, result.state.repeat(2));
  const health = result.calls.findIndex((args) => args.includes("180"));
  const cleanup = result.calls.findIndex(
    ([command, action]) => command === "image" && action === "ls",
  );
  assert.ok(health >= 0 && cleanup > health);
});

test("redeploying the same release preserves the prior release", (t) => {
  const result = deploy(t, { state: state(current, previous), args: ["--loaded-images"] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, state(current, previous));
  assert.equal(result.removed.length, 2);
});

test("legacy state supplies the prior release on the first upgraded deployment", (t) => {
  const result = deploy(t, { state: `ASTRA_IMAGE=${previous}\n` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, state(current, previous));
  assert.equal(result.removed.length, 2);
});

test("first-ever deployment retains only its own pair when no prior successful release is known", (t) => {
  const result = deploy(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, state(current));
  assert.deepEqual(
    result.removed.map((args) => args[2]),
    [previous, `${previous}-migrate`, older, `${older}-migrate`],
  );
});

test("redeploying an older release retains the previously active release", (t) => {
  const result = deploy(t, { release: previous, state: state(current, previous) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, state(previous, current));
  assert.equal(result.removed.length, 2);
});

for (const fail of [
  "compose --profile tools pull",
  "compose run --rm --no-deps migrate",
  "compose up -d --no-deps --wait --wait-timeout 180 bot",
]) {
  test(`failed deployment preserves state and skips cleanup: ${fail}`, (t) => {
    const original = state(previous, older);
    const result = deploy(t, { state: original, fail });
    assert.notEqual(result.status, 0);
    assert.ok(result.calls.some((args) => args.join(" ").startsWith(fail)));
    assert.equal(result.state, original);
    assert.deepEqual(result.removed, []);
    assert.ok(!result.calls.some(([command]) => command === "image"));
  });
}

test("images used by any container are retained, even through another tag", (t) => {
  const result = deploy(t, {
    state: state(previous),
    usedIds: [`sha256:${"c".repeat(40)}`, `sha256:${"c".repeat(40)}-migrate`],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.removed, []);
  assert.ok(result.calls.some((args) => args.join(" ") === "ps -aq"));
});

for (const fail of ["image ls", "ps -aq", "container inspect", "image rm"]) {
  test(`cleanup failure warns without failing a healthy deployment: ${fail}`, (t) => {
    const result = deploy(t, { state: state(previous), fail, usedIds: ["sha256:unrelated"] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.state, state(current, previous));
    assert.match(result.stderr, /Warning: image cleanup incomplete/);
    if (fail !== "image rm") assert.deepEqual(result.removed, []);
    else assert.equal(result.removed.length, 2);
  });
}

test("invalid stored state fails before any Docker operation", (t) => {
  const original = "ASTRA_IMAGE=$(touch should-not-exist)\n";
  const result = deploy(t, { state: original });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid release state/);
  assert.equal(result.state, original);
  assert.deepEqual(result.calls, []);
});
