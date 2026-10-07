import { test, expect } from "bun:test";
import { toSelectOptions, type SearchResult } from "./search";

function makeResult(index: number): SearchResult {
  return {
    source: "youtube",
    videoId: `v${index}`,
    title: `Track ${index}`,
    duration: 200,
    uploader: `Uploader ${index}`,
    url: `https://www.youtube.com/watch?v=v${index}`,
    thumbnail: `https://i.ytimg.com/vi/v${index}/default.jpg`,
  };
}

test("toSelectOptions: caps at 25 by default", () => {
  const results = Array.from({ length: 30 }, (_, i) => makeResult(i));
  expect(toSelectOptions(results)).toHaveLength(25);
});

test("toSelectOptions: honours an explicit smaller cap", () => {
  const results = Array.from({ length: 30 }, (_, i) => makeResult(i));
  expect(toSelectOptions(results, 3)).toHaveLength(3);
});

test("toSelectOptions: duplicate urls collapse to the first option", () => {
  const first = { ...makeResult(0), title: "First" };
  const second = { ...makeResult(0), title: "Second" };
  const options = toSelectOptions([first, second]);
  expect(options).toHaveLength(1);
  expect(options[0].label).toBe("First");
});

test("toSelectOptions: a 200-char title yields a label Discord accepts", () => {
  const options = toSelectOptions([{ ...makeResult(0), title: "x".repeat(200) }]);
  expect(options[0].label.length).toBeLessThanOrEqual(100);
  expect(options[0].label).toContain("…");
});

test("toSelectOptions: a null duration never renders null", () => {
  const options = toSelectOptions([{ ...makeResult(0), duration: null }]);
  expect(JSON.stringify(options[0])).not.toContain("null");
});

test("toSelectOptions: a null uploader never renders null", () => {
  const options = toSelectOptions([{ ...makeResult(0), uploader: null }]);
  expect(JSON.stringify(options[0])).not.toContain("null");
});

test("toSelectOptions: every value is the source url", () => {
  const results = Array.from({ length: 30 }, (_, i) => makeResult(i));
  const options = toSelectOptions(results, 10);
  for (let i = 0; i < options.length; i++) {
    expect(options[i].value).toBe(results[i].url);
  }
});

test("toSelectOptions: description stays within Discord's 100-char limit", () => {
  const options = toSelectOptions([
    { ...makeResult(0), uploader: "u".repeat(200), duration: 3725 },
  ]);
  expect(options[0].description.length).toBeLessThanOrEqual(100);
});
