const { Octokit } = require("@octokit/rest");
const yaml = require("js-yaml");
const { Minimatch } = require("minimatch");
  
async function getLabelGlobs(client, owner, repo, configurationPath) {
    const configurationContent = await fetchContent(
        client,
        owner,
        repo,
        "master",
        configurationPath
    );
  
    // loads (hopefully) a `{[label:string]: string | StringOrMatchConfig[]}`, but is `any`:
    const configObject = yaml.load(configurationContent);
  
    // transform `any` => `Map<string,StringOrMatchConfig[]>` or throw if yaml is malformed:
    return getLabelGlobMapFromObject(configObject);
}
  
async function fetchContent(client, owner, repo, ref, repoPath) {
    const response = await client.rest.repos.getContent({
        owner: owner,
        repo: repo,
        path: repoPath,
        ref: ref,
    });
  
    return Buffer.from(response.data.content, response.data.encoding).toString();
}
  
function getLabelGlobMapFromObject(configObject) {
    const labelGlobs = new Map();
    for (const label in configObject) {
        if (typeof configObject[label] === "string") {
            labelGlobs.set(label, [configObject[label]]);
        } else if (configObject[label] instanceof Array) {
            labelGlobs.set(label, configObject[label]);
        } else {
            throw Error(`found unexpected type for label ${label} (should be string or array of globs)`);
        }
    }
  
    return labelGlobs;
}
  
function toMatchConfig(config) {
    if (typeof config === "string") {
        return {
            any: [config],
        };
    }
  
    return config;
}
  
function printPattern(matcher) {
    return (matcher.negate ? "!" : "") + matcher.pattern;
}
  
function checkGlobs(changedFiles, globs) {
    for (const glob of globs) {
        const matchConfig = toMatchConfig(glob);
        if (checkMatch(changedFiles, matchConfig)) {
            return true;
        }
    }
    return false;
}
  
function isMatch(changedFile, matchers) {
    for (const matcher of matchers) {
        if (!matcher.match(changedFile)) {
            return false;
        }
    }

    return true;
}
  
// equivalent to "Array.some()" but expanded for debugging and clarity
function checkAny(changedFiles, globs) {
    const matchers = globs.map((g) => new Minimatch(g));
    for (const changedFile of changedFiles) {
        if (isMatch(changedFile, matchers)) {
            return true;
        }
    }
  
    return false;
}
  
// equivalent to "Array.every()" but expanded for debugging and clarity
function checkAll(changedFiles, globs) {
    const matchers = globs.map((g) => new Minimatch(g));
    for (const changedFile of changedFiles) {
        if (!isMatch(changedFile, matchers)) {
            return false;
        }
    }
  
    return true;
}
  
function checkMatch(changedFiles, matchConfig) {
    if (matchConfig.all !== undefined) {
        if (!checkAll(changedFiles, matchConfig.all)) {
            return false;
        }
    }
  
    if (matchConfig.any !== undefined) {
        if (!checkAny(changedFiles, matchConfig.any)) {
            return false;
        }
    }
  
    return true;
}
  
async function addLabels(client, owner, repo, prNumber, labels) {
    await client.rest.issues.addLabels({
        owner: owner,
        repo: repo,
        issue_number: prNumber,
        labels: labels,
    });
}

async function getChangedFiles(client, owner, repo, prNumber) {
    const listFilesOptions = client.rest.pulls.listFiles.endpoint.merge({
        owner: owner,
        repo: repo,
        pull_number: prNumber,
    });
  
    const listFilesResponse = await client.paginate(listFilesOptions);
    const changedFiles = listFilesResponse.map((f) => f.filename);
  
    return changedFiles;
}

async function processPr(client, owner, repo, configurationPath, pullRequest, labelGlobs, whatIfMode) {
    const changedFiles = await getChangedFiles(client, owner, repo, pullRequest.number);

    const labels = [];
    for (const [label, globs] of labelGlobs.entries()) {
        if (checkGlobs(changedFiles, globs)) {
            labels.push(label);
        }
    }

    if (labels.length > 0) {
        if (!whatIfMode) {
            await addLabels(client, owner, repo, pullRequest.number, labels);
        }
        else {
            console.log(`Would have added the following labels to https://github.com/${owner}/${repo}/pull/${pullRequest.number}`);
            console.log(labels)
        }
    }
}

async function run(owner, repo, githubToken, configurationPath, whatIfMode){
    const client = new Octokit({auth: githubToken});
    const labelGlobs = await getLabelGlobs(client, owner, repo, configurationPath);

    pulls = []
    page = 1
    firstTime = true
    while (firstTime || pulls.length > 0) {
        firstTime = false
        result = await client.rest.pulls.list({
            owner: owner,
            repo: repo,
            state: "all",
            page: page
        });
        if (result.status == 200) {
            pulls = result.data;
            i = 0
            retries = 3
            while (i < pulls.length) {
                try {
                    await processPr(client, owner, repo, configurationPath, pulls[i], labelGlobs, whatIfMode)
                    i += 1
                }
                catch(err) {
                    if (retries > 0) {
                        console.log(`Last request failed with err ${err}. Sleeping for a second then retrying.`)
                        await new Promise(r => setTimeout(r, 1000)); // Sleep for a second for backoff purposes
                    } else {
                        console.log(`Last request failed with err ${err}. No more retries remaining, skipping pr.`)
                    }
                }
            }
            if (pulls.length > 0) {
                console.log(`Processed ${(page-1)*30 + pulls.length} PRs`)
            }
            page += 1
        }
        console.log("Sleeping for 4 minutes to avoid rate limiting")
        await new Promise(r => setTimeout(r, 240000)); // Sleep for 4 minutes between pages
    }
}

function assertArgs(args) {
    if (!args[3]) {
        throw new Error("Not enough args specified. Must specify at least 4 args (node index.js <owner> <repo> <token> <path to config file in your repo at master> <optionally - true/false for what if mode>)");
    }
}

const args = process.argv.slice(2);
assertArgs(args);

// Expecting args in order of node index.js <owner> <repo> <token> <path to config file in your repo at master> <optionally - true/false for what if mode>
// Example: node index.js damccorm backfill-pr-labels <your token in plain text> .github/autolabeler.yml true
run(args[0], args[1], args[2], args[3], args[4]);