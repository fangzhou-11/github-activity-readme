const core = require("@actions/core");
const { getOctokit } = require("@actions/github");
const fs = require("fs");
const { spawn } = require("child_process");

// Get config
const GH_USERNAME = core.getInput("GH_USERNAME");
const COMMIT_NAME = core.getInput("COMMIT_NAME");
const COMMIT_EMAIL = core.getInput("COMMIT_EMAIL");
const COMMIT_MSG = core.getInput("COMMIT_MSG");
const MAX_LINES = core.getInput("MAX_LINES");
const TARGET_FILE = core.getInput("TARGET_FILE");
const EMPTY_COMMIT_MSG = core.getInput("EMPTY_COMMIT_MSG");
const FILTER_EVENTS = core.getInput("FILTER_EVENTS");

/**
 * Returns the sentence case representation
 * @param {String} str - the string
 *
 * @returns {String}
 */

const capitalize = (str) => str.slice(0, 1).toUpperCase() + str.slice(1);

/**
 * Returns a URL in markdown format for PR's and issues
 * @param {Object | String} item - holds information concerning the issue/PR
 *
 * @returns {String}
 */
const toUrlFormat = (item) => {
    if (typeof item !== "object") {
        return `[\`${item}\`](https://github.com/${item})`;
    }

    const payload = item.payload || {};
    const repoName = item.repo && item.repo.name;

    // Comment (issue/PR/commit/review comment)
    if (Object.prototype.hasOwnProperty.call(payload, "comment")) {
        const c = payload.comment;
        if (payload.issue && payload.issue.number) {
            return `[\`#${payload.issue.number}\`](${c.html_url || c.url})`;
        }
        if (payload.pull_request && payload.pull_request.number) {
            return `[\`#${payload.pull_request.number}\`](${c.html_url || c.url})`;
        }
        if (c && c.commit_id) {
            const short = c.commit_id.slice(0, 7);
            const url = c.html_url || `https://github.com/${repoName}/commit/${c.commit_id}`;
            return `[\`${short}\`](${url})`;
        }
        if (c && c.html_url) {
            return `[\`comment\`](${c.html_url})`;
        }
    }

    // Pull request review (review object)
    if (Object.prototype.hasOwnProperty.call(payload, "review") && payload.review) {
        const r = payload.review;
        if (r.html_url) return `[\`review\`](${r.html_url})`;
        // fallback to PR link when available
        if (payload.pull_request && payload.pull_request.number) {
            const prNumber = payload.pull_request.number;
            const repoRef = repoName || (payload.pull_request.base && payload.pull_request.base.repo && payload.pull_request.base.repo.full_name);
            return `[\`review\`](${`https://github.com/${repoRef}/pull/${prNumber}`})`;
        }
    }

    // Issue
    if (Object.prototype.hasOwnProperty.call(payload, "issue") && payload.issue && payload.issue.html_url) {
        return `[\`#${payload.issue.number}\`](${payload.issue.html_url})`;
    }

    // Pull request
    if (Object.prototype.hasOwnProperty.call(payload, "pull_request") && payload.pull_request) {
        const prNumber = payload.pull_request.number;
        if (payload.pull_request.html_url) {
            return `[\`#${prNumber}\`](${payload.pull_request.html_url})`;
        }
        const repoRef = repoName || (payload.pull_request.base && payload.pull_request.base.repo && payload.pull_request.base.repo.full_name);
        return `[\`#${prNumber}\`](https://github.com/${repoRef}/pull/${prNumber})`;
    }

    // Release
    if (Object.prototype.hasOwnProperty.call(payload, "release") && payload.release) {
        const release = payload.release.name || payload.release.tag_name;
        return `[\`${release}\`](${payload.release.html_url})`;
    }

    // Fork
    if (Object.prototype.hasOwnProperty.call(payload, "forkee") && payload.forkee && payload.forkee.html_url) {
        const name = payload.forkee.full_name || payload.forkee.name;
        return `[\`${name}\`](${payload.forkee.html_url})`;
    }

    // Gist
    if (Object.prototype.hasOwnProperty.call(payload, "gist") && payload.gist && payload.gist.html_url) {
        return `[\`gist\`](${payload.gist.html_url})`;
    }

    // Deployment - prefer html_url when available
    if (Object.prototype.hasOwnProperty.call(payload, "deployment") && payload.deployment) {
        const d = payload.deployment;
        if (d.html_url) return `[\`deployment\`](${d.html_url})`;
        if (d.statuses_url) return `[\`deployment\`](${d.statuses_url})`;
        if (d.url) return `[\`deployment\`](${d.url})`;
    }

    // Workflow run
    if (Object.prototype.hasOwnProperty.call(payload, "workflow_run") && payload.workflow_run) {
        const w = payload.workflow_run;
        if (w.html_url) return `[\`workflow run\`](${w.html_url})`;
        if (w.url) return `[\`workflow run\`](${w.url})`;
    }

    // Check run
    if (Object.prototype.hasOwnProperty.call(payload, "check_run") && payload.check_run) {
        const c = payload.check_run;
        if (c.html_url) return `[\`check run\`](${c.html_url})`;
        if (c.url) return `[\`check run\`](${c.url})`;
    }

    // Discussion
    if (Object.prototype.hasOwnProperty.call(payload, "discussion") && payload.discussion && payload.discussion.html_url) {
        return `[\`discussion\`](${payload.discussion.html_url})`;
    }

    // Create / Delete refs (branch/tag)
    if (Object.prototype.hasOwnProperty.call(payload, "ref") && Object.prototype.hasOwnProperty.call(payload, "ref_type") && repoName) {
        const ref = payload.ref;
        const type = payload.ref_type;
        if (type === "branch") {
            return `[\`${ref}\`](https://github.com/${repoName}/tree/${ref})`;
        }
        if (type === "tag") {
            return `[\`${ref}\`](https://github.com/${repoName}/releases/tag/${ref})`;
        }
        return `[\`${ref}\`](${ref})`;
    }

    // Fallback to repo link when possible
    if (repoName) {
        return `[\`${repoName}\`](https://github.com/${repoName})`;
    }

    return "[unknown](https://github.com)";
};

/**
 * Execute shell command
 * @param {String} cmd - root command
 * @param {String[]} args - args to be passed along with
 *
 * @returns {Promise<void>}
 */

const exec = (cmd, args = []) =>
    new Promise((resolve, reject) => {
        const app = spawn(cmd, args);

        let stdout = "";
        if (app.stdout) {
            app.stdout.on("data", (data) => {
                stdout += data.toString();
            });
        }

        let stderr = "";
        if (app.stderr) {
            app.stderr.on("data", (data) => {
                stderr += data.toString();
            });
        }

        app.on("close", (code) => {
            if (code !== 0 && !stdout.includes("nothing to commit")) {
                return reject(
                    new Error(
                        `Command: ${cmd} ${args.join(" ")}\nExit code: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
                    ),
                );
            }
            return resolve(stdout);
        });

        app.on("error", (err) =>
            reject(
                new Error(
                    `Command: ${cmd} ${args.join(" ")}\nError: ${err && err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
                ),
            ),
        );
    });

/**
 * Make a commit
 *
 * @returns {Promise<void>}
 */

const commitFile = async (emptyCommit = false) => {
    await exec("git", ["config", "--global", "user.email", COMMIT_EMAIL]);
    await exec("git", ["config", "--global", "user.name", COMMIT_NAME]);
    if (emptyCommit) {
        await exec("git", ["commit", "--allow-empty", "-m", EMPTY_COMMIT_MSG]);
    } else {
        await exec("git", ["add", TARGET_FILE]);
        await exec("git", ["commit", "-m", COMMIT_MSG]);
    }
    await exec("git", ["push"]);
};

/**
 * Creates an empty commit if no activity has been detected for over 50 days
 * @returns {Promise<void>}
 * */
const createEmptyCommit = async () => {
    const lastCommitDate = await exec("git", [
        "--no-pager",
        "log",
        "-1",
        "--format=%ct",
    ]);

    const commitDate = new Date(parseInt(lastCommitDate, 10) * 1000);
    const diffInDays = Math.round(
        (new Date() - commitDate) / (1000 * 60 * 60 * 24),
    );

    core.info(`Last commit date: ${commitDate}`);
    core.info(`Difference in days: ${diffInDays}`);

    if (diffInDays > 50) {
        core.info("Create empty commit to keep workflow active");
        await commitFile(true);
        return "Empty commit pushed";
    }

    return "No PullRequest/Issue/IssueComment/Release events found. Leaving README unchanged with previous activity";
};

const serializers = {
    IssueCommentEvent: (item) => {
        return `🗣 Commented on ${toUrlFormat(item)} in ${toUrlFormat(
            item.repo.name,
        )}`;
    },
    IssuesEvent: (item) => {
        let emoji = "ℹ️";

        switch (item.payload.action) {
            case "opened":
                emoji = "❗";
                break;
            case "reopened":
                emoji = "🔓";
                break;
            case "closed":
                emoji = "🔒";
                break;
        }

        return `${emoji} ${capitalize(item.payload.action)} issue ${toUrlFormat(
            item,
        )} in ${toUrlFormat(item.repo.name)}`;
    },
    PullRequestEvent: (item) => {
        let emoji = "ℹ️";
        let actionText = capitalize(item.payload.action);

        switch (item.payload.action) {
            case "opened":
                emoji = "💪";
                actionText = "Opened";
                break;
            case "closed":
                emoji = "❌";
                actionText = "Closed";
                break;
            case "merged":
                emoji = "🎉";
                actionText = "Merged";
                break;
        }

        return `${emoji} ${actionText} PR ${toUrlFormat(item)} in ${toUrlFormat(item.repo.name)}`;
    },
    ReleaseEvent: (item) => {
        return `🚀 ${capitalize(item.payload.action)} release ${toUrlFormat(
            item,
        )} in ${toUrlFormat(item.repo.name)}`;
    },
    PushEvent: (item) => {
        const repoName = item.repo && item.repo.name;
        const ref = item.payload && item.payload.ref ? item.payload.ref.replace("refs/heads/", "") : "";

        const commits = (item.payload && item.payload.commits) || [];
        let headSha = (item.payload && (item.payload.after || item.payload.head)) || (item.payload && item.payload.head_commit && (item.payload.head_commit.id || item.payload.head_commit.sha));
        if (!headSha && commits.length) {
            const last = commits[commits.length - 1];
            headSha = last && (last.sha || last.id || last.commit_id || last.sha1);
        }

        const short = headSha ? headSha.slice(0, 7) : "";

        // Build markdown links with inline-code link text when possible
        const shaLink = headSha && repoName ? `[\`${short}\`](https://github.com/${repoName}/commit/${headSha})` : (short ? `\`${short}\`` : "");
        const refLink = ref && repoName ? `[\`${ref}\`](https://github.com/${repoName}/tree/${ref})` : (ref ? `\`${ref}\`` : "");
        const repoLink = repoName ? toUrlFormat(repoName) : "";

        let base = `📦 Pushed ${shaLink || (short ? `\`${short}\`` : "")}`;
        if (ref) base += ` to ${refLink || ref}`;
        if (repoName) base += ` in ${repoLink}`;
        return base;
    },
    CommitCommentEvent: (item) => {
        const repoName = item.repo.name;
        const comment = item.payload && item.payload.comment;
        if (comment) {
            const sha = comment.commit_id ? comment.commit_id.slice(0, 7) : "";
            const url = comment.html_url || `https://github.com/${repoName}`;
            return `📝 Commented on commit [\`${sha}\`](${url}) in ${toUrlFormat(repoName)}`;
        }
        return `📝 Commented on a commit in ${toUrlFormat(repoName)}`;
    },
    CreateEvent: (item) => {
        const repoName = item.repo.name;
        const refType = item.payload && item.payload.ref_type;
        const ref = item.payload && item.payload.ref;
        if (refType && ref) {
            return `🆕 Created ${refType} ${ref} in ${toUrlFormat(repoName)}`;
        }
        return `🆕 Created in ${toUrlFormat(repoName)}`;
    },
    ForkEvent: (item) => {
        const repoName = item.repo && item.repo.name;
        const forkee = item.payload && item.payload.forkee;
        if (forkee && forkee.html_url) {
            const name = forkee.full_name || forkee.name || forkee.fullName || repoName;
            return `🍴 Forked [\`${name}\`](${forkee.html_url})`;
        }
        return `🍴 Forked ${toUrlFormat(repoName)}`;
    },
    WatchEvent: (item) => {
        const repoName = item.repo.name;
        return `⭐ Starred ${toUrlFormat(repoName)}`;
    },
    FollowEvent: (item) => {
        const target = item.payload && item.payload.target && item.payload.target.login;
        return `👥 Followed ${toUrlFormat(target || "")}`;
    },
    PullRequestReviewEvent: (item) => {
        const repoName = item.repo.name;
        const actionText = item.payload && item.payload.action ? capitalize(item.payload.action) : "Reviewed";
        return `✅ ${actionText} review for PR ${toUrlFormat(item)} in ${toUrlFormat(repoName)}`;
    },
    PullRequestReviewCommentEvent: (item) => {
        return `💬 Commented on PR review ${toUrlFormat(item)} in ${toUrlFormat(item.repo.name)}`;
    },
    GistEvent: (item) => {
        const action = item.payload && item.payload.action ? capitalize(item.payload.action) : "";
        const gist = item.payload && item.payload.gist;
        if (gist && gist.html_url) {
            return `📄 ${action} gist [\`gist\`](${gist.html_url})`;
        }
        return `📄 ${action} gist`;
    },
    MemberEvent: (item) => {
        const repoName = item.repo.name;
        const member = item.payload && item.payload.member && item.payload.member.login;
        return `🔗 ${capitalize(item.payload.action || "changed")} collaborator ${toUrlFormat(member || "")} in ${toUrlFormat(repoName)}`;
    },
    DeleteEvent: (item) => {
        const repoName = item.repo.name;
        const refType = item.payload && item.payload.ref_type;
        const ref = item.payload && item.payload.ref;
        return `🗑️ Deleted ${refType || "ref"} ${ref || ""} in ${toUrlFormat(repoName)}`;
    },
    DeploymentEvent: (item) => {
        const repoName = item.repo.name;
        const env = item.payload && item.payload.deployment && item.payload.deployment.environment;
        return `🚀 Created deployment${env ? ` (${env})` : ""} in ${toUrlFormat(repoName)}`;
    },
    PublicEvent: (item) => {
        return `🌍 Made ${toUrlFormat(item.repo.name)} public`;
    },
};

const run = async () => {
    try {
        const token = process.env.GITHUB_TOKEN;

        if (!token) {
            core.setFailed("GITHUB_TOKEN is required to fetch activity.");
            return;
        }

        const octokit = getOctokit(token);

        // Get the user's events
        core.info(`Getting activity for ${GH_USERNAME}`);

        let events;
        try {
            const authUser = await octokit.rest.users.getAuthenticated();
            const authLogin = authUser?.data?.login;
            core.info(`Authenticated as ${authLogin}`);
            if (authLogin && authLogin.toLowerCase() === GH_USERNAME.toLowerCase()) {
                core.info("Fetching authenticated events");
                events = await octokit.rest.activity.listEventsForAuthenticatedUser({
                    username: GH_USERNAME,
                    per_page: 100
                });
            } else {
                core.info("Fetching public events");
                events = await octokit.rest.activity.listPublicEventsForUser({
                    username: GH_USERNAME,
                    per_page: 100,
                });
            }
        } catch (e) {
            core.info(`Auth check failed: ${e.message}`);
            core.info('Falling back to public events');
            try {
                events = await octokit.rest.activity.listPublicEventsForUser({
                    username: GH_USERNAME,
                    per_page: 100,
                });
            } catch (fallbackError) {
                core.info(`Authenticated fallback failed: ${fallbackError.message}`);
                core.info('Fetching public events using an unauthenticated client');
                const { Octokit } = require("@octokit/core");
                const unauthenticatedOctokit = new Octokit();
                const response = await unauthenticatedOctokit.request("GET /users/{username}/events/public", {
                    username: GH_USERNAME,
                    per_page: 100,
                });
                events = { data: response.data };
            }
        }

        core.info(`Activity for ${GH_USERNAME}, ${events.data.length} events found.`);

        const maxLines = parseInt(MAX_LINES, 10) || 5;

        const filtered = events.data.filter(
            (event) => serializers.hasOwnProperty(event.type) && FILTER_EVENTS.includes(event.type),
        );

        const limited = filtered.slice(0, maxLines);

        // Call the serializer (supports async serializers) to construct strings
        const content = await Promise.all(
            limited.map((item) => Promise.resolve(serializers[item.type](item, octokit))),
        );

        const readmeContent = fs
            .readFileSync(`./${TARGET_FILE}`, "utf-8")
            .split("\n");

        // Find the index corresponding to <!--START_SECTION:activity--> comment
        let startIdx = readmeContent.findIndex(
            (content) => content.trim() === "<!--START_SECTION:activity-->",
        );

        // Early return in case the <!--START_SECTION:activity--> comment was not found
        if (startIdx === -1) {
            core.setFailed(
                "Couldn't find the <!--START_SECTION:activity--> comment. Exiting!",
            );
            return;
        }

        // Find the index corresponding to <!--END_SECTION:activity--> comment
        const endIdx = readmeContent.findIndex(
            (content) => content.trim() === "<!--END_SECTION:activity-->",
        );

        if (content.length === 0) {
            core.info("Found no activity.");

            try {
                const message = await createEmptyCommit();
                core.info(message);
            } catch (err) {
                core.setFailed(err.message);
            }
            return;
        }

        if (content.length < 5) {
            core.info("Found less than 5 activities");
        }

        if (startIdx !== -1 && endIdx === -1) {
            // Add one since the content needs to be inserted just after the initial comment
            startIdx++;
            content.forEach((line, idx) =>
                readmeContent.splice(startIdx + idx, 0, `${idx + 1}. ${line}`),
            );

            // Append <!--END_SECTION:activity--> comment
            readmeContent.splice(
                startIdx + content.length,
                0,
                "<!--END_SECTION:activity-->",
            );

            // Update README
            fs.writeFileSync(`./${TARGET_FILE}`, readmeContent.join("\n"));

            // Commit to the remote repository
            try {
                await commitFile();
            } catch (err) {
                core.setFailed(err.message);
                return;
            }
            core.info("Wrote to README");
            return;
        }

        const oldContent = readmeContent.slice(startIdx + 1, endIdx).join("\n");
        const newContent = content
            .map((line, idx) => `${idx + 1}. ${line}`)
            .join("\n");

        if (oldContent.trim() === newContent.trim()) {
            core.info("No changes detected");
            return;
        }

        startIdx++;

        // Recent GitHub Activity content between the comments
        const readmeActivitySection = readmeContent.slice(startIdx, endIdx);
        if (!readmeActivitySection.length) {
            content.some((line, idx) => {
                // User doesn't have 5 public events
                if (!line) {
                    return true;
                }
                readmeContent.splice(startIdx + idx, 0, `${idx + 1}. ${line}`);
            });
            core.info(`Wrote to ${TARGET_FILE}`);
        } else {
            // It is likely that a newline is inserted after the <!--START_SECTION:activity--> comment (code formatter)
            let count = 0;

            readmeActivitySection.some((line, idx) => {
                // User doesn't have 5 public events
                if (!content[count]) {
                    return true;
                }
                if (line !== "") {
                    readmeContent[startIdx + idx] = `${count + 1}. ${content[count]}`;
                    count++;
                }
            });
            core.info(`Updated ${TARGET_FILE} with the recent activity`);
        }

        // Update README
        fs.writeFileSync(`./${TARGET_FILE}`, readmeContent.join("\n"));

        // Commit to the remote repository
        try {
            await commitFile();
        } catch (err) {
            core.setFailed(err.message);
            return;
        }
        core.info("Pushed to remote repository");
    } catch (error) {
        core.setFailed(error.message);
    }
};

run();
