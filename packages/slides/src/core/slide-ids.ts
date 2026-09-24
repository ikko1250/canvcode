/**
 * スライドの id（name）。
 * キャンバスに並べたスライドの画像と、その上に置いた書き込みを、並べ替えや追加・削除のあとも
 * 同じスライドに結び付けるために使う。デッキの name（Markdown の `{#name}`）をそのまま id とし、
 * 無いスライドには `s-xxxxxx` を振る。利用者が付けた name はそのまま使う。
 */
import type { DeckData } from "./slide-schema.ts";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 6;

/** taken と重ならない新しい id。SLIDE_NAME_PATTERN に合う */
export function newSlideName(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const bytes = new Uint8Array(ID_LENGTH);
    globalThis.crypto.getRandomValues(bytes);
    let id = "s-";
    for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    if (!taken.has(id)) return id;
  }
}

/** name の無いスライドに id を振ったデッキ。全スライドに name があれば、同じオブジェクトを返す */
export function assignSlideNames<T extends Pick<DeckData, "slides">>(deck: T): T {
  if (deck.slides.every((slide) => slide.name)) return deck;
  const taken = new Set(deck.slides.flatMap((slide) => (slide.name ? [slide.name] : [])));
  return {
    ...deck,
    slides: deck.slides.map((slide) => {
      if (slide.name) return slide;
      const name = newSlideName(taken);
      taken.add(name);
      return { ...slide, name };
    }),
  };
}

/** キャンバス上でスライドを見分けるキー。name が無いスライド（まだ id を振っていない）は位置で見分ける */
export function slideKey(slide: { name?: string | undefined }, index: number): string {
  return slide.name ? slide.name : `@${index}`;
}
