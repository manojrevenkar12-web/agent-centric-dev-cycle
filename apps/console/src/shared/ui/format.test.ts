import { renderEvidence } from "./Evidence";
import { levelName, pct, usd } from "./format";

test("formats rates, money and levels, and shows a dash for no data", () => {
  expect(pct(0.256)).toBe("26%");
  expect(pct(null)).toBe("–");
  expect(usd(1.5)).toBe("$1.50");
  expect(levelName("agent_draft")).toBe("Agent draft");
});

test("renders evidence markdown without passing HTML through", () => {
  const html = renderEvidence("### What ran\n- tests **pass** in `x.ts`\n<script>alert(1)</script>");
  expect(html).toContain("<h3>What ran</h3>");
  expect(html).toContain("<strong>pass</strong>");
  expect(html).toContain("<code>x.ts</code>");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});
