#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function collectJsonlFiles(directory) {
  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }

  return files;
}

function readSessionMetadata(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(65536);
  const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
  fs.closeSync(descriptor);

  for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
    try {
      const record = JSON.parse(line);
      if (record.type === 'session_meta' && record.payload?.id) {
        return {
          id: record.payload.id,
          parentThreadId: record.payload.parent_thread_id ?? null,
          filePath,
        };
      }
    } catch {
      // Ignore incomplete or non-JSON lines in the bounded metadata prefix.
    }
  }

  return null;
}

function parseRollout(filePath) {
  let metadata = null;
  let usage = null;
  let planType = null;
  const contexts = [];
  const requestInputCounts = [];

  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === 'session_meta') metadata = record.payload;
    if (record.type === 'turn_context') {
      contexts.push({
        model: record.payload.model ?? null,
        reasoning: record.payload.effort ?? null,
        serviceTier: record.payload.service_tier ?? null,
      });
    }
    if (record.type === 'token_usage_record') {
      usage = record.payload.thread_token_usage ?? null;
      if (Number.isFinite(record.payload.usage?.input_tokens)) {
        requestInputCounts.push(record.payload.usage.input_tokens);
      }
    }
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
      planType = record.payload.rate_limits?.plan_type ?? planType;
    }
  }

  if (!metadata?.id) return null;

  const uniqueContexts = contexts.filter((context, index, all) =>
    all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(context)) === index,
  );
  const inputTokens = usage?.input_tokens ?? null;
  const cachedInputTokens = usage?.cached_input_tokens ?? null;

  return {
    threadId: metadata.id,
    parentThreadId: metadata.parent_thread_id ?? null,
    agentPath: metadata.source?.subagent?.thread_spawn?.agent_path ?? null,
    platformRole: metadata.source?.subagent?.other ?? (metadata.parent_thread_id ? 'subagent' : 'coordinator'),
    sourceFile: path.basename(filePath),
    contexts: uniqueContexts,
    planType,
    requestCount: requestInputCounts.length,
    maxRequestInputTokens: requestInputCounts.length ? Math.max(...requestInputCounts) : null,
    requestsOver272K: requestInputCounts.filter((count) => count > 272000).length,
    usage: usage ? {
      inputTokens,
      cachedInputTokens,
      uncachedInputTokens: inputTokens - cachedInputTokens,
      cacheWriteInputTokens: usage.cache_write_input_tokens ?? 0,
      outputTokens: usage.output_tokens,
      reasoningOutputTokens: usage.reasoning_output_tokens,
      totalTokens: usage.total_tokens,
    } : null,
  };
}

const rootThreadId = readArgument('--root-thread-id');
const sessionsDirectory = readArgument('--sessions-dir');

if (!rootThreadId || !sessionsDirectory) {
  fail('Usage: extract-codex-telemetry.mjs --root-thread-id <id> --sessions-dir <directory>');
}
if (!fs.existsSync(sessionsDirectory)) fail(`Sessions directory not found: ${sessionsDirectory}`);

const rolloutIndex = collectJsonlFiles(sessionsDirectory)
  .map(readSessionMetadata)
  .filter(Boolean);
const includedIds = new Set([rootThreadId]);
let changed = true;

while (changed) {
  changed = false;
  for (const rollout of rolloutIndex) {
    if (rollout.parentThreadId && includedIds.has(rollout.parentThreadId) && !includedIds.has(rollout.id)) {
      includedIds.add(rollout.id);
      changed = true;
    }
  }
}

const result = rolloutIndex
  .filter((rollout) => includedIds.has(rollout.id))
  .map((rollout) => parseRollout(rollout.filePath))
  .filter(Boolean)
  .sort((left, right) => left.sourceFile.localeCompare(right.sourceFile));

if (!result.some((rollout) => rollout.threadId === rootThreadId)) {
  fail(`Root thread not found: ${rootThreadId}`);
}

process.stdout.write(`${JSON.stringify({
  source: 'Codex rollout session_meta, turn_context, token_usage_record, and token_count records',
  rootThreadId,
  coverage: 'Root thread and all descendant threads found under the supplied sessions directory',
  rollouts: result,
}, null, 2)}\n`);
