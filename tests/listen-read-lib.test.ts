import { describe, expect, test } from "bun:test";

import {
  conversationListSql,
  mapConversationColumns,
  transcriptTurnsFromInline,
  type ConversationMeta,
} from "../skills/tc-listen-read/scripts/listen-read-lib.ts";

describe("tc-listen-read inline SQL transcripts", () => {
  const baseMeta: ConversationMeta = {
    id: "conversation-1",
    title: "Inline transcript",
  };

  test("parses transcript_json arrays from Listen SQL rows", () => {
    const turns = transcriptTurnsFromInline({
      ...baseMeta,
      transcript_json: JSON.stringify([
        {
          index: 3,
          speaker_name: "Ari",
          text: "We should publish the feed.",
          start_time: 12,
        },
      ]),
    });

    expect(turns).toEqual([
      {
        index: 3,
        speaker_id: undefined,
        speaker_name: "Ari",
        text: "We should publish the feed.",
        start_time: 12,
        end_time: undefined,
        language: undefined,
      },
    ]);
  });

  test("parses nested Fireflies-style transcript_json rows", () => {
    const turns = transcriptTurnsFromInline({
      ...baseMeta,
      transcript_json: JSON.stringify({
        transcript: [
          { speaker: "Hunter", content: "Route this through Artifactory." },
        ],
      }),
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.speaker_name).toBe("Hunter");
    expect(turns[0]?.text).toBe("Route this through Artifactory.");
  });

  test("falls back to transcript_text when JSON is unavailable", () => {
    const turns = transcriptTurnsFromInline({
      ...baseMeta,
      transcript_text: "Plain transcript body",
    });

    expect(turns).toEqual([
      {
        index: 0,
        speaker_name: "Transcript",
        text: "Plain transcript body",
      },
    ]);
  });
});

describe("tc-listen-read SQL backpressure", () => {
  test("lists conversation metadata without selecting inline transcript payloads", () => {
    const columns = mapConversationColumns([
      "id",
      "title",
      "started_at",
      "transcript_json",
      "transcript_text",
    ]);
    const sql = conversationListSql(columns);

    expect(sql).toContain(`"id" AS id`);
    expect(sql).toContain(`"title" AS title`);
    expect(sql).toContain(`"started_at" AS started_at`);
    expect(sql).toContain("has_inline_transcript");
    expect(sql).toContain("LIMIT ? OFFSET ?");
    expect(sql).not.toContain(`"transcript_json" AS transcript_json`);
    expect(sql).not.toContain(`"transcript_text" AS transcript_text`);
  });

  test("rejects unsafe reflected SQL column names", () => {
    expect(() =>
      conversationListSql({
        id: "id; DROP TABLE conversation",
      }),
    ).toThrow("unsafe SQL column name");
  });

  test("conversation list query remains offset-addressable for run rotation", () => {
    const columns = mapConversationColumns(["id"]);
    expect(conversationListSql(columns)).toEndWith("LIMIT ? OFFSET ?");
  });
});
