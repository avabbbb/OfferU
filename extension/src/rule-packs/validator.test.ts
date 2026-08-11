// =============================================
// validator 测试：覆盖 site-rule-pack-v1.md 第 14 节全部 12 类拒绝输入
// =============================================

import { describe, expect, it } from "vitest";
import { validatePack, type ValidationError } from "./validator.js";
import type { SiteRulePackV1 } from "./contracts.js";
import rawJobDetailPack from "./packs/fixture.acme-job-detail.json";
import rawApplicationFormPack from "./packs/fixture.acme-application-form.json";

// JSON 推断为宽类型；框架边界处收窄为规范类型
const jobDetailPack: SiteRulePackV1 = rawJobDetailPack as unknown as SiteRulePackV1;
const applicationFormPack: SiteRulePackV1 = rawApplicationFormPack as unknown as SiteRulePackV1;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorsOf(input: unknown): ValidationError[] {
  const result = validatePack(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected validation failure");
  return result.errors;
}

function codesOf(input: unknown): string[] {
  return errorsOf(input).map((e) => e.code);
}

describe("validatePack - valid synthetic packs", () => {
  it("accepts the two fixture packs", () => {
    expect(validatePack(clone(jobDetailPack)).ok).toBe(true);
    expect(validatePack(clone(applicationFormPack)).ok).toBe(true);
  });
});

describe("validatePack - unknown fields (rule 1)", () => {
  it("rejects top-level script/endpoint/hook/transformCode", () => {
    for (const key of ["script", "endpoint", "hook", "transformCode"]) {
      const bad = clone(jobDetailPack);
      (bad as unknown as Record<string, unknown>)[key] = "evil";
      expect(codesOf(bad)).toContain("unknown-field");
    }
  });

  it("rejects nested unknown fields on signals and selector candidates", () => {
    const bad = clone(jobDetailPack);
    bad.pages[0].match.signals[0] = {
      ...bad.pages[0].match.signals[0],
      transformCode: "document.body.innerHTML=''",
    } as never;
    expect(codesOf(bad)).toContain("unknown-field");

    const bad2 = clone(jobDetailPack);
    (bad2.pages[0].jobDetail!.fields.title.selectors.candidates[0] as unknown as Record<string, unknown>).eval = "x";
    expect(codesOf(bad2)).toContain("unknown-field");
  });
});

describe("validatePack - host rules (rule 2)", () => {
  it.each([
    ["https://jobs.acme.invalid", "scheme"],
    ["jobs.acme.invalid/path", "path"],
    ["*.acme.invalid", "wildcard"],
    ["Jobs.ACME.Invalid", "uppercase"],
    ["jobs.acme.invalid:8443", "port"],
  ])("rejects host %s", (value) => {
    const bad = clone(jobDetailPack);
    bad.hosts = [{ kind: "exact", value }];
    expect(codesOf(bad)).toContain("invalid-host");
  });
});

describe("validatePack - path-glob (rule 3)", () => {
  it.each([["/jobs/[abc]"], ["/jobs/(x)"], ["/jobs/*.html$"], ["/jobs/a b"]])(
    "rejects path-glob %s",
    (value) => {
      const bad = clone(jobDetailPack);
      bad.pages[0].match.signals[0].value = value;
      expect(codesOf(bad)).toContain("invalid-path-glob");
    },
  );

  it("rejects bare /** and triple star", () => {
    for (const value of ["/**", "/***", "**"]) {
      const bad = clone(jobDetailPack);
      bad.pages[0].match.signals[0].value = value;
      expect(codesOf(bad)).toContain("invalid-path-glob");
    }
  });
});

describe("validatePack - selectors (rule 4)", () => {
  it("rejects :contains() and unbalanced brackets", () => {
    for (const css of [":contains('x')", "[data-testid='x'", "div("]) {
      const bad = clone(jobDetailPack);
      bad.pages[0].match.signals[1].value = css;
      expect(codesOf(bad)).toContain("invalid-selector");
    }
  });

  it("rejects css longer than 300 chars", () => {
    const bad = clone(jobDetailPack);
    bad.pages[0].jobDetail!.fields.title.selectors.candidates[0].css = `[data-testid='${"a".repeat(320)}']`;
    expect(codesOf(bad)).toContain("too-long");
  });

  it("rejects more than 8 candidates", () => {
    const bad = clone(jobDetailPack);
    bad.pages[0].jobDetail!.fields.title.selectors.candidates = Array.from(
      { length: 9 },
      (_, i) => ({ css: `[data-x='${i}']`, stability: "fragile" as const }),
    );
    expect(codesOf(bad)).toContain("candidate-count");
  });

  it("rejects maxMatches out of range", () => {
    for (const maxMatches of [0, 501]) {
      const bad = clone(jobDetailPack);
      bad.pages[0].jobDetail!.fields.title.selectors.maxMatches = maxMatches;
      expect(codesOf(bad)).toContain("invalid-max-matches");
    }
  });
});

describe("validatePack - drivers (rule 5)", () => {
  it("rejects unknown driverId", () => {
    const bad = clone(applicationFormPack);
    (bad.pages[0].form!.controls[0] as Record<string, unknown>).driverId = "custom";
    expect(codesOf(bad)).toContain("unknown-driver");
  });

  it("rejects antd binding missing required popup role", () => {
    const bad = clone(applicationFormPack);
    const control = bad.pages[0].form!.controls[0];
    delete (control.selectors as unknown as Record<string, unknown>).popup;
    expect(codesOf(bad)).toContain("missing-role");
  });

  it("rejects native driver declaring selectors", () => {
    const bad = clone(applicationFormPack);
    bad.pages[0].form!.controls[0] = {
      id: "native-x",
      when: bad.pages[0].form!.controls[0].when,
      driverId: "native",
      selectors: { host: bad.pages[0].form!.controls[0].when },
    } as never;
    expect(codesOf(bad)).toContain("native-no-selectors");
  });

  it("rejects feishu with incomplete tree roles", () => {
    const bad = clone(applicationFormPack);
    const control = bad.pages[0].form!.controls[0];
    bad.pages[0].form!.controls[0] = {
      id: "feishu-tree",
      when: control.when,
      driverId: "feishu",
      selectors: {
        host: control.selectors!.host,
        popup: control.selectors!.popup,
        option: control.selectors!.option,
        "tree-root": control.selectors!.host,
      },
    } as never;
    expect(codesOf(bad)).toContain("incomplete-tree-roles");
  });

  it("rejects feishu with only one date role", () => {
    const bad = clone(applicationFormPack);
    const control = bad.pages[0].form!.controls[0];
    bad.pages[0].form!.controls[0] = {
      id: "feishu-date",
      when: control.when,
      driverId: "feishu",
      selectors: {
        host: control.selectors!.host,
        popup: control.selectors!.popup,
        option: control.selectors!.option,
        "calendar-panel": control.selectors!.host,
      },
    } as never;
    expect(codesOf(bad)).toContain("incomplete-date-roles");
  });
});

describe("validatePack - page kind consistency (rule 6)", () => {
  it("rejects job-detail page carrying a form", () => {
    const bad = clone(jobDetailPack);
    bad.pages[0].form = clone(applicationFormPack).pages[0].form;
    expect(codesOf(bad)).toContain("kind-config-conflict");
  });

  it("rejects job-detail missing jobDetail", () => {
    const bad = clone(jobDetailPack);
    delete bad.pages[0].jobDetail;
    expect(codesOf(bad)).toContain("missing-kind-config");
  });
});

describe("validatePack - duplicate ids (rule 7)", () => {
  it("rejects duplicate page rule ids", () => {
    const bad = clone(jobDetailPack);
    bad.pages.push(clone(jobDetailPack.pages[0]));
    expect(codesOf(bad)).toContain("duplicate-id");
  });

  it("rejects duplicate signal ids", () => {
    const bad = clone(jobDetailPack);
    bad.pages[0].match.signals.push(clone(bad.pages[0].match.signals[0]));
    expect(codesOf(bad)).toContain("duplicate-id");
  });

  it("rejects duplicate control binding ids", () => {
    const bad = clone(applicationFormPack);
    bad.pages[0].form!.controls.push(clone(bad.pages[0].form!.controls[0]));
    expect(codesOf(bad)).toContain("duplicate-id");
  });

  it("rejects duplicate fixture ids", () => {
    const bad = clone(jobDetailPack);
    bad.fixtures.push(clone(bad.fixtures[0]));
    expect(codesOf(bad)).toContain("duplicate-id");
  });
});

describe("validatePack - verified fixture completeness (rule 8)", () => {
  it("rejects verified pack without near-negative fixture", () => {
    const bad = clone(jobDetailPack);
    bad.fixtures = bad.fixtures.filter((f) => f.role !== "near-negative");
    expect(codesOf(bad)).toContain("missing-fixture");
  });

  it("rejects verified pack without conflict fixture", () => {
    const bad = clone(jobDetailPack);
    bad.fixtures = bad.fixtures.filter((f) => f.role !== "conflict");
    expect(codesOf(bad)).toContain("missing-fixture");
  });

  it("rejects verified pack without lastVerifiedAt", () => {
    const bad = clone(jobDetailPack);
    delete bad.provenance.lastVerifiedAt;
    expect(codesOf(bad)).toContain("missing-verified-date");
  });

  it("rejects verified pack whose only positive signals are weak tokens", () => {
    const bad = clone(jobDetailPack);
    bad.pages[0].match.signals = [
      { id: "t1", type: "title-token", polarity: "positive", value: "Engineer", weight: 40 },
      { id: "t2", type: "meta-token", polarity: "positive", value: "fixtures", weight: 40 },
    ];
    expect(codesOf(bad)).toContain("verified-weak-detection");
  });
});

describe("validatePack - receipt rules (rule 9)", () => {
  function receiptPack(): Record<string, unknown> {
    const pack = clone(jobDetailPack);
    pack.pages[0] = {
      id: "receipt",
      kind: "submission-receipt",
      match: {
        minScore: 60,
        minPositiveSignals: 1,
        ambiguityMargin: 10,
        signals: [{ id: "p", type: "path-glob", polarity: "positive", value: "/done/*", weight: 60 }],
      },
      capabilities: ["read-submission-receipt"],
      receipt: {
        requiresActiveFillSession: true,
        minScore: 60,
        minPositiveGroups: 2,
        positiveGroups: [
          { id: "g1", anyOf: [{ type: "title-token", value: "Thank you", weight: 40 }] },
          { id: "g2", anyOf: [{ type: "path-glob", value: "/done/*", weight: 40 }] },
        ],
        negativeSignals: [{ type: "title-token", value: "Validation error", weight: 90, veto: true }],
        evidence: {},
      },
    } as never;
    pack.fixtures = [
      { id: "r-pos", pageKind: "submission-receipt", role: "positive", path: "fixtures/acme/detail.html", sanitized: true },
      { id: "r-neg", pageKind: "submission-receipt", role: "near-negative", path: "fixtures/acme/detail.html", sanitized: true },
      { id: "r-con", pageKind: "submission-receipt", role: "conflict", path: "fixtures/acme/detail.html", sanitized: true },
    ];
    pack.status = "experimental";
    delete pack.provenance.lastVerifiedAt;
    return pack as unknown as Record<string, unknown>;
  }

  it("rejects receipt without active session requirement", () => {
    const bad = receiptPack();
    const page = (bad.pages as Array<Record<string, unknown>>)[0];
    page.receipt = {
      ...(page.receipt as Record<string, unknown>),
      requiresActiveFillSession: false,
    };
    expect(codesOf(bad)).toContain("session-required");
  });

  it("rejects receipt with a single positive group", () => {
    const bad = receiptPack();
    const page = (bad.pages as Array<Record<string, unknown>>)[0];
    const receipt = page.receipt as Record<string, unknown>;
    receipt.positiveGroups = [((receipt.positiveGroups as unknown[])[0])];
    expect(codesOf(bad)).toContain("group-count");
  });
});

describe("validatePack - capability whitelist (rule 10)", () => {
  it.each(["upload", "consent", "submit", "captcha", "write-anything"])(
    "rejects capability %s",
    (capability) => {
      const bad = clone(jobDetailPack);
      bad.pages[0].capabilities = [capability as never];
      expect(codesOf(bad)).toContain("unknown-capability");
    },
  );
});

describe("validatePack - fixture paths (rule 11)", () => {
  it.each([
    ["Niuke/fixture.html", "niuke-path"],
    ["/etc/passwd.html", "absolute-path"],
    ["C:/Users/x/f.html", "absolute-path"],
    ["fixtures/../evil.html", "unsafe-path"],
    ["fixtures/acme/notes.txt", "wrong-extension"],
  ])("rejects fixture path %s", (path, code) => {
    const bad = clone(jobDetailPack);
    bad.fixtures[0].path = path;
    expect(codesOf(bad)).toContain(code);
  });
});

describe("validatePack - secrets (rule 12)", () => {
  it("rejects aliases containing suspected secrets without echoing value", () => {
    const bad = clone(applicationFormPack);
    bad.pages[0].form!.aliases.push({
      canonicalIntent: "full_name",
      aliases: ["sk-live-abcdefgh12345678"],
    });
    const errors = errorsOf(bad);
    expect(errors.some((e) => e.code === "suspicious-secret")).toBe(true);
    expect(errors.some((e) => e.message.includes("sk-live"))).toBe(false);
  });

  it("rejects selector strings that look like api keys", () => {
    const bad = clone(jobDetailPack);
    bad.pages[0].jobDetail!.fields.company.selectors.candidates[0].css = "AKIAIOSFODNN7EXAMPLE";
    expect(codesOf(bad)).toContain("suspicious-secret");
  });
});
