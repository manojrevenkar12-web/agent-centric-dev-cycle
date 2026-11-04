# 0002 Change risk from the repository's own history

## Decision

The risk of a change is the probability that it needs a revert or a follow-up fix within 7 days,
from a logistic regression on what is known when the pull request opens: size, packages, test share,
owning and required teams, sensitive paths, area of the code, conventional-commit type, and how many
fixes the changed files had in the previous 30 days. It is trained on n8n's merged changes up to the
end of August 2026 and tested on September and October.

## Why this label

n8n squash-merges and almost never reverts (6 reverts in 10,589 merged changes), so reverts alone
cannot train anything. A follow-up fix is a small fix (at most 5 source files) whose source files
are mostly ones the change touched, merged within a week. It is a proxy with known noise: busy files
attract fixes for reasons unrelated to the change. The ablation without the file-history feature
(AUC 0.73 instead of 0.77) shows how much of the model rests on that.

## Why logistic regression

Every weight can be read and argued about in a design review, and the data is 7,000 rows. A gradient
boosted model would score a little better and would be harder to defend when it blocks a change.

## Limits

- OWNERS was added on 1 September 2026; the training months use today's OWNERS for structure.
- The live service computes file history from git at start-up and refreshes it hourly.
- The model ranks changes; its probabilities are calibrated on history (ECE 0.03), not on agent
  changes, which may differ. The shadow period is where that is checked.
