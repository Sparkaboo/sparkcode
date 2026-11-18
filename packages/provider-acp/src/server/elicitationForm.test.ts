import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  for (const type of ["string", "array"] as const) {
    it.each([
      { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"] },
      { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"] },
      { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
    ])(
      `preserves ${type} enum values with distinct readable labels: $values`,
      ({ values, labels }) => {
        const form = parseElicitationForm(
          {
            type: "object",
            properties: {
              answer:
                type === "array"
                  ? { type, items: { type: "string", enum: values } }
                  : { type, enum: values },
            },
            required: ["answer"],
          },
          "Choose",
        );
        assert(form !== undefined);
        const question = form.questions[0];
        assert(question !== undefined);
        assert.deepStrictEqual(
          question.options.map((option) => option.label),
          labels,
        );
        assert.deepStrictEqual(
          question.options.map((option) => option.value),
          values,
        );
        assert.strictEqual(question.allowCustomAnswer, false);
        assert.strictEqual(question.multiSelect, type === "array" ? true : undefined);
        for (const value of values) {
          const answer = type === "array" ? [value] : value;
          assert.deepStrictEqual(form.content({ answer }), { answer });
        }
      },
    );
  }

  it("asks each question once when a choice has a free-text companion field", () => {
    // OMP's ask dialog follows each choice `q<n>` with a free-text `q<n>__other` field.
    const ask = (question: string, header: string) => ({
      type: "string",
      title: question,
      description: header,
      oneOf: [
        { const: "Yes", title: "Yes" },
        { const: "No", title: "No" },
      ],
    });
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: ask("Use Postgres for the new service?", "Database"),
          q0__other: { type: "string", title: "Other (type your own)" },
          q1: ask("Deploy to staging first?", "Deploy"),
          q1__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Answer 2 questions",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) =>
        [question.header, question.question].some((text) => text.endsWith("?")),
      ),
      [true, true],
    );
    assert.deepStrictEqual(form.content({ q0: "Yes", q1: "Only on Fridays" }), {
      q0: "Yes",
      q1__other: "Only on Fridays",
    });

    // Title-only choice fields keep the full prompt in `question` instead of truncating it in
    // `header`, and fold single-underscore free-text companions structurally.
    const titleOnlyChoice = (question: string, options: ReadonlyArray<string>) => ({
      type: "string",
      title: question,
      oneOf: options.map((title, index) => ({ const: String(index + 1), title })),
    });
    const antigravityForm = parseElicitationForm(
      {
        type: "object",
        properties: {
          q1: titleOnlyChoice("1. 模板的组织颗粒度：拆成两套库还是收敛为一套序列剧本库？", [
            "(Recommended) 统一为多渠道序列剧本库",
            "完全对齐双层资产库",
          ]),
          q1_other: {
            type: "string",
            title: "Other",
            description:
              "Optional free-form answer to: 1. 模板的组织颗粒度：拆成两套库还是收敛为一套序列剧本库？",
          },
          q2: titleOnlyChoice("2. 步骤编辑器采用哪种内容形态？", [
            "(Recommended) 单步支持三态切换",
            "纯 AI 剧本模式",
          ]),
          q2_other: {
            type: "string",
            title: "Other",
            description: "Optional free-form answer to: 2. 步骤编辑器采用哪种内容形态？",
          },
        },
      },
      "The agent has 2 questions.",
    );
    assert(antigravityForm !== undefined);
    assert.deepStrictEqual(
      antigravityForm.questions.map((entry) => ({
        id: entry.id,
        header: entry.header,
        question: entry.question,
        optionCount: entry.options.length,
        allowCustomAnswer: entry.allowCustomAnswer,
      })),
      [
        {
          id: "q1",
          header: "Question 1",
          question: "1. 模板的组织颗粒度：拆成两套库还是收敛为一套序列剧本库？",
          optionCount: 2,
          allowCustomAnswer: undefined,
        },
        {
          id: "q2",
          header: "Question 2",
          question: "2. 步骤编辑器采用哪种内容形态？",
          optionCount: 2,
          allowCustomAnswer: undefined,
        },
      ],
    );
    assert.deepStrictEqual(
      antigravityForm.content({
        q1: '1\n\nAttached file "spec.md": "/tmp/spec.md"',
        q2: "希望保留个性化插槽",
      }),
      {
        q1: "1",
        q1_other: 'Attached file "spec.md": "/tmp/spec.md"',
        q2_other: "希望保留个性化插槽",
      },
    );

    // Multiple subfields under one choice are distinct fields, not a single custom-answer companion.
    const multiSubfield = parseElicitationForm(
      {
        type: "object",
        properties: {
          auth: { type: "string", title: "Auth mode?", enum: ["basic", "token"] },
          auth_user: { type: "string", title: "Username" },
          auth_pass: { type: "string", title: "Password" },
        },
      },
      "Configure auth",
    );
    assert(multiSubfield !== undefined);
    assert.deepStrictEqual(
      multiSubfield.questions.map((entry) => entry.id),
      ["auth", "auth_user", "auth_pass"],
    );

    // A multi-select answer can carry options and free text together, so both fields stay,
    // while the companion text field is marked optional (`required: false`).
    const multi = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: { type: "array", title: "Databases?", items: { anyOf: [{ const: "Postgres" }] } },
          q0__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "The agent has a question.",
    );
    assert(multi !== undefined);
    assert.deepStrictEqual(
      multi.questions.map((entry) => ({
        id: entry.id,
        header: entry.header,
        question: entry.question,
        required: entry.required,
      })),
      [
        { id: "q0", header: "Question 1", question: "Databases?", required: undefined },
        {
          id: "q0__other",
          header: "Question 2",
          question: "Other (type your own)",
          required: false,
        },
      ],
    );
    assert.deepStrictEqual(multi.content({ q0: ["Postgres"], q0__other: "SQLite" }), {
      q0: ["Postgres"],
      q0__other: "SQLite",
    });
    assert.deepStrictEqual(multi.content({ q0: ["Postgres"] }), {
      q0: ["Postgres"],
    });
  });
});
