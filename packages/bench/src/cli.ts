/** acdc: the command line for the studies and the benchmark.
 *
 *   acdc history          mine n8n's merged changes and label outcomes  (needs N8N_REPO)
 *   acdc risk             train the change-risk model, replay automated approval in shadow mode
 *   acdc owners-check     compare our OWNERS matcher with n8n's own on every file (needs N8N_REPO)
 *   acdc tasks            mine benchmark tasks from fix commits and validate them (needs N8N_REPO)
 *   acdc run              run agents on the tasks in sandboxes (needs N8N_REPO and the claude CLI)
 *   acdc regrade          grade stored runs again with the current grader (no agent reruns)
 *   acdc judge            a model reads each failed or passed change next to n8n's merged fix
 *   acdc report           summarise runs into reports/bench.json and reports/RESULTS.md
 */
import { label, readHistory } from "./history.js";

const N8N = process.env.N8N_REPO ?? "";
const need = () => {
  if (!N8N) throw new Error("set N8N_REPO to an n8n checkout with history since config/risk.yaml: since");
  return N8N;
};

async function main(cmd: string | undefined, args: string[]) {
  switch (cmd) {
    case "history": {
      const { loadConfig } = await import("@acdc/core");
      const { writeDataset } = await import("./dataset.js");
      const rows = label(readHistory(need(), loadConfig<{ since: string }>("risk").since));
      writeDataset(rows);
      const bad = rows.filter((r) => r.bad).length;
      console.log(`${rows.length} merged changes, ${bad} bad (${((100 * bad) / rows.length).toFixed(1)}%)`);
      return;
    }
    case "risk": {
      const { main: risk } = await import("./risk-train.js");
      const r = risk();
      console.log(
        JSON.stringify(
          { auc: r.test.auc, auc_naive_rule: r.test.auc_naive_rule, shadow: r.test.shadow },
          null,
          1,
        ),
      );
      return;
    }
    case "owners-check": {
      const { ownersCheck } = await import("./owners-check.js");
      const r = await ownersCheck(need());
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { ROOT } = await import("@acdc/core");
      writeFileSync(join(ROOT, "reports/owners-check.json"), `${JSON.stringify(r, null, 2)}\n`);
      console.log(JSON.stringify(r, null, 1));
      return;
    }
    case "tasks": {
      const { mineTasks } = await import("./tasks.js");
      await mineTasks(need(), args);
      return;
    }
    case "run": {
      const { runBench } = await import("./run.js");
      await runBench(need(), args);
      return;
    }
    case "regrade": {
      const { regradeAll } = await import("./run.js");
      await regradeAll(need());
      return;
    }
    case "judge": {
      const { judgeAll } = await import("./judge.js");
      await judgeAll(need());
      return;
    }
    case "report": {
      const { writeReport } = await import("./report.js");
      writeReport();
      return;
    }
    default:
      console.log("usage: acdc history|risk|owners-check|tasks|run|judge|report");
      process.exitCode = cmd ? 2 : 0;
  }
}

main(process.argv[2], process.argv.slice(3)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
