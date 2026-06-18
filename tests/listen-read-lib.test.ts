import { describe, expect, test } from "bun:test";

import {
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
