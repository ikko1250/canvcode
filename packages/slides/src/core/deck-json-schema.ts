/**
 * エディタ補完用 JSON Schema（draft-07）を生成する。
 * 行数上限はレイアウトスペックから導出するため、schema/deck.schema.json は `npm run schema` で再生成する。
 * 実行時の検証は slide-schema.ts（TypeScript）が単一ソースであり、本スキーマは整合テストで突き合わせる。
 */
import { BULLETS_SPEC, getMaxRowCount, SLIDE_LAYOUTS } from "./slide-layout-spec.ts";
import {
  IMAGE_OFFSET_MAX,
  IMAGE_OFFSET_MIN,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  SLIDE_NAME_PATTERN,
} from "./slide-schema.ts";

type JsonSchema = Record<string, unknown>;

const nonEmptyString: JsonSchema = { type: "string", minLength: 1 };

const imageAdjustProperties: JsonSchema = {
  zoom: {
    type: "number",
    minimum: IMAGE_ZOOM_MIN,
    maximum: IMAGE_ZOOM_MAX,
    default: 1,
    description: "拡大率（1 = 枠に収める）。既定値のときは省略",
  },
  x: {
    type: "number",
    minimum: IMAGE_OFFSET_MIN,
    maximum: IMAGE_OFFSET_MAX,
    default: 0,
    description: "横のずらし（枠の幅に対する %）。既定値のときは省略",
  },
  y: {
    type: "number",
    minimum: IMAGE_OFFSET_MIN,
    maximum: IMAGE_OFFSET_MAX,
    default: 0,
    description: "縦のずらし（枠の高さに対する %）。既定値のときは省略",
  },
};

const linesSchema: JsonSchema = {
  description: "行テキスト。文字列配列（各行非空）または改行（\\n）入りの文字列。**強調** が使える。",
  oneOf: [
    { type: "string", minLength: 1 },
    { type: "array", minItems: 1, items: nonEmptyString },
  ],
};

const rowSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["labelLines", "bodyLines"],
  properties: {
    labelLines: { ...linesSchema, description: "左列（ラベル）のテキスト行" },
    bodyLines: { ...linesSchema, description: "右列（本文）のテキスト行" },
  },
};

function rowsSchema(maxItems: number): JsonSchema {
  return { type: "array", minItems: 1, maxItems, items: rowSchema };
}

const imageSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "alt"],
  properties: {
    path: { ...nonEmptyString, description: "画像パス（デッキファイルからの相対パスまたは絶対パス）" },
    alt: { ...nonEmptyString, description: "代替テキスト" },
    ...imageAdjustProperties,
  },
};

const imagesItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "alt", "title"],
  properties: {
    path: { ...nonEmptyString, description: "画像パス（デッキファイルからの相対パスまたは絶対パス）" },
    alt: { ...nonEmptyString, description: "代替テキスト" },
    title: { ...nonEmptyString, description: "図タイトル（黒字プレーンテキスト）" },
    ...imageAdjustProperties,
  },
};

const codeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "コード行。空文字で空行を表す",
    },
    language: { ...nonEmptyString, description: "言語名（表示には未使用）" },
  },
};

function bulletItemSchema(depth: number): JsonSchema {
  const objectSchema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { ...nonEmptyString, description: "項目のテキスト。**強調** が使える" },
      ...(depth < BULLETS_SPEC.maxDepth
        ? {
            children: {
              type: "array",
              minItems: 1,
              items: bulletItemSchema(depth + 1),
              description: `子項目（第 ${depth + 1} 階層）`,
            },
          }
        : {}),
    },
  };
  return { oneOf: [nonEmptyString, objectSchema] };
}

function forbid(keys: string[]): JsonSchema {
  return { not: { anyOf: keys.map((key) => ({ required: [key] })) } };
}

export function buildDeckJsonSchema(): JsonSchema {
  const maxTable = getMaxRowCount("table");
  const maxTableImage = getMaxRowCount("table-image");
  const maxTableImages = getMaxRowCount("table-images");
  const maxBullets = getMaxRowCount("bullets");
  const maxOverall = Math.max(maxTable, maxTableImage, maxTableImages);

  const slideSchema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      name: {
        type: "string",
        pattern: SLIDE_NAME_PATTERN.source,
        description: "PNG 出力時のファイル名。英小文字・数字・ハイフン。デッキ内で一意",
      },
      layout: {
        type: "string",
        enum: [...SLIDE_LAYOUTS],
        default: "table",
        description:
          "table: 全幅表 / table-image: 左表・右図（image か code）/ table-images: 上表・下2図 / title: 表紙 / bullets: 箇条書き",
      },
      title: { ...nonEmptyString, description: "スライドタイトル（title レイアウトでは発表タイトル）" },
      rows: { ...rowsSchema(maxOverall), description: "表の行（table / table-image / table-images）" },
      items: {
        type: "array",
        minItems: 1,
        maxItems: maxBullets,
        items: bulletItemSchema(1),
        description: `bullets 用の項目（1〜${maxBullets} 件、${BULLETS_SPEC.maxDepth} 階層まで）`,
      },
      image: { ...imageSchema, description: "table-image 用の右図（code と排他）" },
      code: { ...codeSchema, description: "table-image 用の右コード（image と排他）" },
      images: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: imagesItemSchema,
        description: "table-images 用の下2図",
      },
      subtitle: { ...linesSchema, description: "title 用の副題" },
      credits: { ...linesSchema, description: "title 用の発表者・所属・日付など（下部の灰帯に表示）" },
    },
    allOf: [
      {
        if: { properties: { layout: { const: "table-image" } }, required: ["layout"] },
        then: {
          required: ["rows"],
          properties: { rows: rowsSchema(maxTableImage) },
          oneOf: [
            { required: ["image"], not: { required: ["code"] } },
            { required: ["code"], not: { required: ["image"] } },
          ],
          ...forbid(["images", "subtitle", "credits", "items"]),
        },
      },
      {
        if: { properties: { layout: { const: "table-images" } }, required: ["layout"] },
        then: {
          required: ["rows", "images"],
          properties: { rows: rowsSchema(maxTableImages) },
          ...forbid(["image", "code", "subtitle", "credits", "items"]),
        },
      },
      {
        if: { properties: { layout: { const: "title" } }, required: ["layout"] },
        then: forbid(["rows", "image", "code", "images", "items"]),
      },
      {
        if: { properties: { layout: { const: "bullets" } }, required: ["layout"] },
        then: {
          required: ["items"],
          ...forbid(["rows", "image", "code", "images", "subtitle", "credits"]),
        },
      },
      {
        if: { properties: { layout: { const: "table" } } },
        then: {
          required: ["rows"],
          properties: { rows: rowsSchema(maxTable) },
          ...forbid(["image", "code", "images", "subtitle", "credits", "items"]),
        },
      },
    ],
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://example.invalid/slide-deck.schema.json",
    title: "スライドデッキ",
    description:
      "表スライド出力テンプレートのデッキ定義。行数上限はレイアウトスペック（src/core/slide-layout-spec.ts）から導出。",
    type: "object",
    additionalProperties: false,
    required: ["slides"],
    properties: {
      $schema: { type: "string" },
      deckTitle: { ...nonEmptyString, description: "デッキ名（描画には未使用）" },
      slides: { type: "array", minItems: 1, items: slideSchema },
    },
  };
}
