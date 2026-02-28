import { describe, expect, test } from "bun:test";
import {
  collectLikelyLocalPathsFromText,
  extractAttachmentCandidates,
  isHighConfidencePathReference
} from "../src/attachments/service.js";

describe("attachments service", () => {
  test("filters weak filename-only declared hints", () => {
    const candidates = extractAttachmentCandidates(
      {
        type: "commandExecution",
        name: "preview.png",
        filename: "preview.png",
        path: "./screenshots/preview.png"
      },
      { attachmentInferFromText: false }
    );

    expect(candidates).toEqual([{ path: "./screenshots/preview.png", intent: "explicit_structured" }]);
  });

  test("uses last-match-wins for inferred paths in one message", () => {
    const candidates = extractAttachmentCandidates(
      {
        type: "commandExecution",
        text: "first: /tmp/one.png then /tmp/two.png"
      },
      { attachmentInferFromText: true }
    );

    expect(candidates).toEqual([{ path: "/tmp/two.png", intent: "inferred_text_fallback" }]);
  });

  test("imageView candidates are tagged as explicit user request intent", () => {
    const candidates = extractAttachmentCandidates(
      {
        type: "imageView",
        path: "/tmp/view.png"
      },
      { attachmentInferFromText: false }
    );

    expect(candidates).toEqual([{ path: "/tmp/view.png", intent: "explicit_user_request" }]);
  });

  test("high-confidence path detection rejects basename-only references", () => {
    expect(isHighConfidencePathReference("latest.png")).toBe(false);
    expect(isHighConfidencePathReference("/tmp/latest.png")).toBe(true);
  });

  test("collectLikelyLocalPathsFromText captures local media paths", () => {
    const found = collectLikelyLocalPathsFromText("see this ![img](/tmp/capture.png)");
    expect(found).toContain("/tmp/capture.png");
  });
});
