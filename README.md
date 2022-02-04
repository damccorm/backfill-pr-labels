# backfill-pr-labels
Repo to backfill pr labels for a repo based on the same config as actions/labeler

To run:

```
npm install
node index.js <owner> <repo> <github token> <path to config> # Example: node index.js damccorm backfill-pr-labels <your token in plain text> .github/autolabeler.yml
```