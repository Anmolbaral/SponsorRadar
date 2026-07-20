import { describe, expect, it } from "vitest";
import { interpretChannelInput } from "@/components/sponsor-radar-demo";

describe("editable channel interpretation", () => {
  it.each([
    ["dave2d", "youtube.com/@dave2d"],
    ["@dave2d", "youtube.com/@dave2d"],
    ["/@dave2d", "youtube.com/@dave2d"],
    ["m.youtube.com/@MKBHD", "youtube.com/@MKBHD"],
    ["/channel/UCAbC123", "youtube.com/channel/UCAbC123"],
    ["/user/LegacyName", "youtube.com/user/LegacyName"],
    ["/c/CustomName", "youtube.com/c/CustomName"],
    ["@cafe\u0301", "youtube.com/@café"]
  ])("shows the canonical interpretation for %s", (input, expected) => {
    expect(interpretChannelInput(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "https://youtube.com/watch?v=abc",
    "https://youtube.com.evil.example/@dave2d",
    "/channel/not-a-channel-id"
  ])("shows no interpretation for invalid input %s", (input) => {
    expect(interpretChannelInput(input)).toBeNull();
  });
});
