import { expect, test } from "bun:test";
import { readOfferDismissed, saveOfferDismissed, showsNotificationOffer } from "../src/lib/notification-offer.ts";

test("the offer shows only in a browser tab whose browser has not been asked yet and the user did not put off", () => {
  expect(showsNotificationOffer(false, "default", false)).toBe(true);
  expect(showsNotificationOffer(true, "default", false)).toBe(false);
  expect(showsNotificationOffer(false, "granted", false)).toBe(false);
  expect(showsNotificationOffer(false, "denied", false)).toBe(false);
  expect(showsNotificationOffer(false, "unsupported", false)).toBe(false);
  expect(showsNotificationOffer(false, "default", true)).toBe(false);
});

test("Not now is remembered in this browser profile", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  expect(readOfferDismissed(() => storage)).toBe(false);
  saveOfferDismissed(() => storage);
  expect(readOfferDismissed(() => storage)).toBe(true);
});

test("storage that refuses access reads as not put off, and a refused write is forgotten", () => {
  const refuse = () => {
    throw new Error("blocked site data");
  };
  expect(readOfferDismissed(refuse)).toBe(false);
  expect(() => saveOfferDismissed(refuse)).not.toThrow();
});
