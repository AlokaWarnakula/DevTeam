// Consensus: proposals the room votes on, approvals of a task version, and the rule that decides
// whether an approval is independent at all.
//
// The invariant with the most history behind it lives here. An agent may not verify work it wrote,
// enforced at claim time by _verifierIsAuthor rather than only at approval — refusing it only at
// approval meant the author was handed the review, read the whole diff, and found that its single
// exit was to block the assignment. _independentClaimantExists is the no-dead-end half: with no
// independent teammate who could actually take it, the author still gets the work and the
// acceptance is labeled selfReviewed rather than the item sitting claimable by nobody.
//
// A mixin on DevTeamStore.prototype, for the reasons in store-checks.mjs. The scheduler in store.mjs
// calls _verifierIsAuthor and _findingsFor directly, which is exactly why those had to stop being
// #private: a mixin and its class cannot share one.
import { randomUUID } from "node:crypto";
import { fromJson, json, now } from "./util.mjs";

// Whether an assignment reads the work rather than changing it — and therefore waits for pending
// writers, earns the right to approve, and puts its task in review — is a column on the row,
// resolved from the project's role config when the assignment was created (see roles.mjs). It is
// deliberately NOT a list of role names here: a project that calls its reviewing role `fact-checker`
// or `structural-engineer` must schedule identically, and no domain vocabulary belongs in this SQL.
const VERIFIES = "verifies = 1";

// The kinds of thing a room can be asked to agree on. Defined here, beside the only code that
// validates against it, and re-exposed as DevTeamStore.PROPOSAL_KINDS so the class keeps the static
// it has always had.
export const PROPOSAL_KINDS = ["role", "handoff", "plan", "decision"];

export const consensusMethods = {
  // Did this assignment read the work rather than change it? Asked of the assignment row rather than
  // of the role name recorded on the event, so a project that renamed its reviewing role still earns
  // approval standing, and a role renamed *after* the fact cannot retroactively grant it.
  _assignmentVerifies(assignmentId) {
    if (!assignmentId) return false;
    return Boolean(this.db.prepare("SELECT verifies FROM assignments WHERE id = ?").get(assignmentId)?.verifies);
  },

  createProposal({ agentId = null, taskId, kind = "role", summary, details = {} }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    if (["accepted", "blocked", "cancelled"].includes(task.status)) throw new Error(this.closedTaskError(task, "open a proposal on it"));
    if (!PROPOSAL_KINDS.includes(kind)) throw new Error(`Unknown proposal kind: ${kind}.`);
    const proposer = agentId ? this.getAgent(agentId) : null;
    const proposerName = proposer ? proposer.name : "You";
    if (kind === "handoff" && !details?.assignmentId) throw new Error("A handoff proposal needs details.assignmentId.");
    if (kind === "role" && !String(details?.role || "").trim()) throw new Error("A role proposal needs details.role.");
    const id = randomUUID();
    const stamp = now();
    // Quorum: 1 (default) = unanimity of the voter set snapshotted now; a fraction in (0,1) adopts
    // once that share of the snapshot agrees (supermajority/majority).
    const ratio = Math.min(1, Math.max(0, Number(details?.quorum) || 1)) || 1;
    // Snapshot the required voter set at creation: exactly the members connected right now, minus
    // the proposer. A teammate connecting mid-vote afterwards can neither block an almost-adopted
    // proposal nor be silently conscripted into it.
    const snapshotVoters = this._connectedMemberIds(taskId).filter((memberId) => memberId !== agentId);
    this._transaction(() => {
      this.db.prepare(`
        INSERT INTO proposals (id, task_id, proposer_id, proposer_name, kind, summary, details, status, created_at, required_ratio)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      `).run(id, taskId, agentId, proposerName, kind, summary.trim(), json(details), stamp, ratio);
      for (const voterId of snapshotVoters) {
        this.db.prepare("INSERT OR IGNORE INTO proposal_voters (proposal_id, voter_id) VALUES (?, ?)").run(id, voterId);
      }
      // An AGENT proposer implicitly agrees to its own proposal. A human proposer gets no implicit
      // vote: the human decides with an explicit dashboard Agree/Object, and pre-seeding a "human
      // agree" here would make that later click an idempotent no-op that never resolves the proposal.
      if (agentId) {
        this.db.prepare(`
          INSERT INTO proposal_votes (proposal_id, voter_id, voter_name, vote, comment, created_at)
          VALUES (?, ?, ?, 'agree', NULL, ?)
        `).run(id, agentId, proposerName, stamp);
      }
      this._event(taskId, agentId, "proposal.created", summary.trim(), { proposalId: id, kind, details, requiredVoters: snapshotVoters.length, quorum: ratio });
    });
    this._changed("proposal.created", taskId);
    return this.getProposal(id);
  },

  getProposal(proposalId) {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId);
    if (!row) return null;
    const votes = this.db.prepare("SELECT voter_id, voter_name, vote, comment, created_at FROM proposal_votes WHERE proposal_id = ? ORDER BY created_at ASC").all(proposalId);
    return { ...row, details: fromJson(row.details, {}), votes };
  },

  voteProposal({ agentId = null, proposalId, vote = "agree", comment = null }) {
    if (!["agree", "object"].includes(vote)) throw new Error("Vote must be 'agree' or 'object'.");
    const voter = agentId ? this.getAgent(agentId) : null;
    const voterName = voter ? voter.name : "You";
    if (agentId) {
      const owning = this.db.prepare("SELECT task_id FROM proposals WHERE id = ?").get(proposalId);
      if (owning) this.assertMembership(agentId, owning.task_id);
    }
    let outcome;
    this._transaction(() => {
      const proposal = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId);
      if (!proposal) throw new Error("Proposal not found.");
      if (proposal.status !== "open") { outcome = { proposalId, taskId: proposal.task_id, status: proposal.status, alreadyResolved: true }; return; }
      const voterId = agentId || "human";
      const stamp = now();
      // Re-casting the identical vote records nothing new and emits no vote event, but we still
      // re-evaluate: a decisive vote already on record — e.g. a legacy proposal pre-seeded with the
      // human's implicit agree — must resolve exactly once instead of being frozen by a no-op. A vote
      // that leaves it open is marked unchanged so it doesn't spam duplicate "vote" change signals.
      const existing = this.db.prepare("SELECT vote FROM proposal_votes WHERE proposal_id = ? AND voter_id = ?").get(proposalId, voterId);
      if (existing && existing.vote === vote) {
        outcome = this._evaluateProposal(proposal, stamp);
        if (outcome.status === "open") outcome.unchanged = true;
        return;
      }
      this.db.prepare(`
        INSERT INTO proposal_votes (proposal_id, voter_id, voter_name, vote, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(proposal_id, voter_id) DO UPDATE SET vote = excluded.vote, comment = excluded.comment, created_at = excluded.created_at
      `).run(proposalId, voterId, voterName, vote, comment?.trim() || null, stamp);
      this._event(proposal.task_id, agentId, "proposal.vote", `${voterName} ${vote === "agree" ? "agreed to" : "objected to"}: ${proposal.summary}`, { proposalId, vote, comment: comment?.trim() || null });
      outcome = this._evaluateProposal(proposal, stamp);
    });
    this.markMessagesSeen(agentId || "");
    // A resolution always signals (even when reached by re-evaluating an identical decisive vote); a
    // vote that merely stays open signals once, and a true no-op stays silent.
    if (outcome?.status === "adopted") this._changed("proposal.adopted", outcome.taskId);
    else if (outcome?.status === "declined") this._changed("proposal.declined", outcome.taskId);
    else if (!outcome?.unchanged && !outcome?.alreadyResolved) this._changed("proposal.vote", outcome?.taskId);
    return outcome;
  },

  // Decide whether an open proposal is now adopted (all required teammates agreed) or
  // declined (someone objected). Runs inside the caller's transaction.
  _evaluateProposal(proposal, stamp) {
    const votes = this.db.prepare("SELECT voter_id, vote FROM proposal_votes WHERE proposal_id = ?").all(proposal.id);
    // Decide against the voter set snapshotted at creation, not whoever is connected right now.
    const snapshot = this.db.prepare("SELECT voter_id FROM proposal_voters WHERE proposal_id = ?").all(proposal.id).map((r) => r.voter_id);
    // The human is the room's owner: an explicit human vote is decisive and overrides agent consensus,
    // so a dashboard Agree/Object actually resolves the proposal (agree adopts, object declines) rather
    // than waiting on agent votes that may never come.
    const humanVote = votes.find((v) => v.voter_id === "human");
    if (humanVote && humanVote.vote === "agree") {
      this._adoptProposal(proposal, stamp);
      this.db.prepare("UPDATE proposals SET status = 'adopted', resolved_at = ? WHERE id = ?").run(stamp, proposal.id);
      return { proposalId: proposal.id, taskId: proposal.task_id, status: "adopted" };
    }
    if (humanVote && humanVote.vote === "object") {
      this.db.prepare("UPDATE proposals SET status = 'declined', resolved_at = ? WHERE id = ?").run(stamp, proposal.id);
      this._event(proposal.task_id, null, "proposal.declined", `Proposal declined: ${proposal.summary}`, { proposalId: proposal.id });
      return { proposalId: proposal.id, taskId: proposal.task_id, status: "declined" };
    }
    const authoritative = new Set([...snapshot, "human"]); // late joiners can neither block nor carry a vote
    const objection = votes.find((v) => v.vote === "object" && authoritative.has(v.voter_id));
    if (objection) {
      this.db.prepare("UPDATE proposals SET status = 'declined', resolved_at = ? WHERE id = ?").run(stamp, proposal.id);
      this._event(proposal.task_id, null, "proposal.declined", `Proposal declined: ${proposal.summary}`, { proposalId: proposal.id });
      return { proposalId: proposal.id, taskId: proposal.task_id, status: "declined" };
    }
    const agreed = new Set(votes.filter((v) => v.vote === "agree").map((v) => v.voter_id));
    const agreements = snapshot.filter((id) => agreed.has(id)).length;
    const ratio = Number(proposal.required_ratio) || 1;
    let adopt;
    if (!snapshot.length) {
      // No teammate was around at creation — only the human can decide a solo proposer's request.
      adopt = agreed.has("human");
    } else if (ratio >= 1) {
      // Unanimity of those still able to vote: a snapshot voter who has since disconnected or gone
      // unresponsive can't hold the whole team hostage, but if none remain it stays open for the
      // human/timeout rather than silently adopting.
      const eligible = snapshot.filter((id) => this._canVoteNow(id));
      adopt = eligible.length > 0 && eligible.every((id) => agreed.has(id));
    } else {
      // Quorum/supermajority against the fixed snapshot denominator.
      const needed = Math.max(1, Math.ceil(ratio * snapshot.length));
      adopt = agreements >= needed;
    }
    if (adopt) {
      this._adoptProposal(proposal, stamp);
      this.db.prepare("UPDATE proposals SET status = 'adopted', resolved_at = ? WHERE id = ?").run(stamp, proposal.id);
      return { proposalId: proposal.id, taskId: proposal.task_id, status: "adopted" };
    }
    // Report what adoption actually needs *now*: for unanimity that is the snapshot voters still able
    // to vote (a disconnected/unresponsive snapshot voter no longer counts), matching the adopt rule
    // above — so the dashboard never shows "need 2" when only one reachable voter remains.
    const needed = ratio >= 1
      ? snapshot.filter((id) => this._canVoteNow(id)).length
      : Math.max(1, Math.ceil(ratio * snapshot.length));
    return { proposalId: proposal.id, taskId: proposal.task_id, status: "open", agreements, needed };
  },

  // An agent can cast a vote right now only if it is connected and actually responsive — an
  // 'unresponsive' (silently busy) agent is present but can't be waited on to break a tie.
  _canVoteNow(agentId) {
    const row = this.db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId);
    return Boolean(row) && row.status !== "disconnected" && row.status !== "unresponsive";
  },

  // Apply an adopted proposal's real effect. Runs inside the caller's transaction.
  _adoptProposal(proposal, stamp) {
    const details = fromJson(proposal.details, {});
    if (proposal.kind === "role") {
      const assignmentId = randomUUID();
      const title = (details.title || `${details.role} work`).toString().trim();
      const description = (details.description || proposal.summary).toString().trim();
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).run(assignmentId, proposal.task_id, title, description, String(details.role).trim(), details.requiresWrite ? 1 : 0, details.targetAgentName?.trim() || null, stamp);
      const adoptedChecklist = this._resolveChecklist(details.role, details.checklist);
      this._storeChecklist(assignmentId, adoptedChecklist);
      if (details.requiresWrite && Array.isArray(details.paths) && details.paths.length) {
        const writePaths = [...new Set(details.paths.map((p) => String(p).trim()).filter(Boolean))].slice(0, 50);
        if (writePaths.length) this.db.prepare("INSERT OR REPLACE INTO assignment_write_scopes (assignment_id, paths) VALUES (?, ?)").run(assignmentId, json(writePaths));
      }
      this._event(proposal.task_id, proposal.proposer_id, "assignment.created", title, { assignmentId, role: details.role, requiresWrite: Boolean(details.requiresWrite), targetAgentName: details.targetAgentName?.trim() || null, viaProposal: proposal.id, checklist: adoptedChecklist || [] });
      this._syncTaskStatus(proposal.task_id, stamp);
    } else if (proposal.kind === "handoff") {
      const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(details.assignmentId);
      if (assignment) {
        const target = details.targetAgentName?.trim() || null;
        if (assignment.status === "claimed") {
          this.db.prepare("UPDATE assignments SET target_agent_name = ?, status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL WHERE id = ?").run(target, assignment.id);
        } else {
          this.db.prepare("UPDATE assignments SET target_agent_name = ? WHERE id = ?").run(target, assignment.id);
        }
        this._event(proposal.task_id, proposal.proposer_id, "assignment.reassigned", `Reassigned "${assignment.title}"${target ? ` to ${target}` : ""}.`, { assignmentId: assignment.id, targetAgentName: target, viaProposal: proposal.id });
        this._syncTaskStatus(proposal.task_id, stamp);
      }
    }
    this._event(proposal.task_id, null, "proposal.adopted", `Team adopted: ${proposal.summary}`, { proposalId: proposal.id, kind: proposal.kind });
  },

  // Open proposals a waiting agent should weigh in on (in its rooms, not its own, not yet voted).
  openProposalsForAgent(agent) {
    const rooms = this._memberTaskIds(agent.id);
    if (!rooms.length) return [];
    const roomPlaceholders = rooms.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT p.* FROM proposals p
      JOIN tasks t ON t.id = p.task_id
      WHERE p.status = 'open'
        AND p.task_id IN (${roomPlaceholders})
        AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
        AND (p.proposer_id IS NULL OR p.proposer_id != ?)
        AND NOT EXISTS (SELECT 1 FROM proposal_votes v WHERE v.proposal_id = p.id AND v.voter_id = ?)
      ORDER BY p.created_at ASC
      LIMIT 20
    `).all(...rooms, agent.id, agent.id);
    return rows.map((row) => ({ id: row.id, taskId: row.task_id, kind: row.kind, summary: row.summary, proposer: row.proposer_name, details: fromJson(row.details, {}) }));
  },

  proposalsForTask(taskId) {
    const rows = this.db.prepare("SELECT * FROM proposals WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
    return rows.map((row) => ({
      ...row,
      details: fromJson(row.details, {}),
      votes: this.db.prepare("SELECT voter_id, voter_name, vote, comment, created_at FROM proposal_votes WHERE proposal_id = ? ORDER BY created_at ASC").all(row.id),
    }));
  },

  // Connected agents that belong to a given task (used to scope proposal consensus).
  _connectedMemberIds(taskId) {
    const connected = this.db.prepare("SELECT id FROM agents WHERE status != 'disconnected'").all().map((row) => row.id);
    return connected.filter((id) => this._memberTaskIds(id).includes(taskId));
  },

  // Who counts as one participant. This followed claimed checkpoint links back to an original
  // session, because a takeover minted a fresh agent id for the same person and an author must not
  // become their own independent reviewer by handing themselves the session. Checkpoints are gone,
  // no other path mints a second id for one participant, and so identity is the whole answer.
  _connectedParticipants(taskId) {
    const members = this.db.prepare(`
      SELECT tm.agent_id FROM task_members tm
      JOIN agents agent ON agent.id = tm.agent_id
      WHERE tm.task_id = ? AND tm.role = 'contributor' AND agent.status != 'disconnected'
    `).all(taskId);
    return new Set(members.map((member) => member.agent_id));
  },

  _currentVersionAuthors(taskId, version) {
    const authors = this.db.prepare(`
      SELECT agent_id, metadata FROM events
      WHERE task_id = ? AND type = 'assignment.completed' AND agent_id IS NOT NULL
    `).all(taskId).filter((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === version && Array.isArray(metadata.changedFiles) && metadata.changedFiles.length > 0;
    });
    return new Set(authors.map((author) => author.agent_id));
  },

  _approvers(taskId, version) {
    const approvals = this.db.prepare("SELECT agent_id FROM approvals WHERE task_id = ? AND version = ?").all(taskId, version);
    return new Set(approvals.map((approval) => approval.agent_id));
  },

  _eligibleIndependentApprovers(taskId, version) {
    const authors = this._currentVersionAuthors(taskId, version);
    return new Set([...this._connectedParticipants(taskId)].filter((agentId) => !authors.has(agentId)));
  },

  // Reviewer ≠ author, asked at claim time. approveTask has always refused a self-approval, but
  // refusing it *only* there meant the author was handed the review claim, read the whole diff, and
  // then found the single exit was to block the assignment: seven blocked assignments on this board
  // are exactly that refusal, the most recent from 2026-08-27, and they are why 264 completed
  // assignments produced two requests for changes. Enforcing it where the claim is handed out costs
  // the team nothing and is the difference between independent review and a rubber stamp.
  //
  // No dead-ends, the same rule the rest of consensus follows: with no independent teammate
  // connected, the author still gets the work and the acceptance is labeled selfReviewed rather than
  // the assignment sitting claimable-by-nobody.
  _verifierIsAuthor(agentId, assignment) {
    const authors = this._currentVersionAuthors(assignment.task_id, assignment.task_version);
    if (!authors.has(agentId)) return false;
    return this._independentClaimantExists(assignment, authors, agentId);
  },

  // "Could somebody else actually take this, right now?" — deliberately not "does an independent
  // teammate exist". The difference is a deadlock, and the property suite found it on the first try:
  // a teammate who is connected but already holding as much work as it can take will never claim
  // this item, so excluding the author on its behalf leaves the assignment queued forever with a
  // reason that reads like a promise nobody is going to keep.
  //
  // Asked through the full explanation surface rather than a hand-rolled subset of it, so this can
  // never drift from what the scan will really do with that teammate.
  //
  // The recursion terminates at one level: whyNotClaimable consults _verifierIsAuthor in turn, but
  // only for the teammates asked about here, and those are non-authors by construction — the author
  // test above returns false for them before reaching this method again.
  _independentClaimantExists(assignment, authors, excludeAgentId) {
    const members = this.db.prepare(`
      SELECT tm.agent_id FROM task_members tm
      JOIN agents agent ON agent.id = tm.agent_id
      WHERE tm.task_id = ? AND tm.role = 'contributor' AND agent.status != 'disconnected'
    `).all(assignment.task_id);
    for (const member of members) {
      if (member.agent_id === excludeAgentId) continue;
      if (authors.has(member.agent_id)) continue;
      if (this.whyNotClaimable(assignment.id, member.agent_id, { refreshLiveness: false }).claimable) return true;
    }
    return false;
  },

  // No dead-ends: configured consensus cannot exceed the independent teammates who could
  // actually approve now. With none available, one honest self-review remains sufficient.
  _effectiveRequiredApprovals(taskId, configured, version) {
    const eligible = this._eligibleIndependentApprovers(taskId, version).size;
    return Math.max(1, Math.min(configured, eligible || 1));
  },

  approveTask({ agentId, taskId, summary }) {
    const agent = this.getAgent(agentId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    if (["blocked", "cancelled"].includes(task.status)) throw new Error(`Cannot approve a ${task.status} task.`);
    if (task.status === "accepted") {
      return { accepted: true, approvalCount: task.required_approvals, requiredApprovals: task.required_approvals, openAssignments: 0, version: task.version };
    }
    const reviewEvidence = this.db.prepare(`
      SELECT metadata FROM events
      WHERE task_id = ? AND agent_id = ? AND type = 'assignment.completed'
      ORDER BY id DESC
    `).all(taskId, agentId).some((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === task.version
        && this._assignmentVerifies(metadata.assignmentId)
        && (!Array.isArray(metadata.changedFiles) || metadata.changedFiles.length === 0);
    });
    if (!reviewEvidence) throw new Error("Approval requires a completed, read-only reviewer or tester assignment on the current task version.");
    // T2.4: where a project has verification enabled, an approval must rest on something DevTeam
    // actually ran. Without this, "verified checks" and "an agent said so" carry identical weight at
    // the one moment that decides whether work ships — which is where the distinction matters most.
    // Projects with no allowlist are unaffected: nothing to verify means nothing to require.
    const verificationEnabled = this.projectCheckCommands(task.project_id).length > 0;
    const verifiedEvidence = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignment_checks c
      JOIN assignments a ON a.id = c.assignment_id
      WHERE a.task_id = ? AND c.superseded_at IS NULL AND c.verified = 1 AND c.status = 'passed'
    `).get(taskId).count) > 0;
    if (verificationEnabled && !verifiedEvidence) {
      throw new Error("This project runs verified checks, and nothing on this task version has passed one. Run an allowlisted check and report it before approving.");
    }
    // Reviewer ≠ author: when the team is more than one agent, the author of the current version
    // cannot approve it — an independent teammate must. A genuine solo run is still allowed to
    // finish (no dead-ends), but its acceptance is labeled selfReviewed so it is never mistaken
    // for independent consensus.
    const authors = this._currentVersionAuthors(taskId, task.version);
    const eligibleIndependent = this._eligibleIndependentApprovers(taskId, task.version);
    if (authors.has(agentId) && eligibleIndependent.size > 0) {
      throw new Error("The author of the current version cannot approve it; an independent reviewer or tester must.");
    }
    let outcome;
    this._transaction(() => {
      const stamp = now();
      // Independence is recorded on the approval, not recomputed later. Whether the approver was the
      // author is a fact about the moment of approving; recomputing it lets the record change as
      // agents connect and disconnect, which is exactly when it must not.
      const independent = !authors.has(agentId);
      this.db.prepare(`
        INSERT INTO approvals (task_id, agent_id, version, summary, created_at, independent, verified_evidence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, agent_id, version) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at,
          independent = excluded.independent, verified_evidence = excluded.verified_evidence
      `).run(taskId, agentId, task.version, summary.trim(), stamp, independent ? 1 : 0, verifiedEvidence ? 1 : 0);
      this._event(taskId, agentId, "task.approved",
        `${agent.name} approved version ${task.version}${independent ? "" : " (self-review: no independent teammate was available)"}.`,
        { summary: summary.trim(), version: task.version, independent, verifiedEvidence });
      const approvers = this._approvers(taskId, task.version);
      const approvalCount = approvers.size;
      const openAssignments = Number(this.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed')").get(taskId).count);
      const effectiveRequired = this._effectiveRequiredApprovals(taskId, task.required_approvals, task.version);
      const accepted = approvalCount >= effectiveRequired && openAssignments === 0;
      // Honest labeling: a lone participant reviewing itself is not consensus.
      const independentApprovalCount = [...approvers].filter((agent) => !authors.has(agent)).length;
      const selfReviewed = authors.size > 0 ? independentApprovalCount === 0 : approvers.size <= 1;
      if (accepted) {
        this.db.prepare("UPDATE tasks SET status = 'accepted', updated_at = ? WHERE id = ?").run(stamp, taskId);
        this._event(taskId, null, "task.accepted", `${selfReviewed ? "Self-reviewed acceptance" : "Consensus reached"} for version ${task.version}.`, { approvalCount, requiredApprovals: effectiveRequired, selfReviewed });
        // Keep the room's agents assembled (status 'waiting', membership intact) rather than force-
        // disconnecting them on acceptance, so the human can send a same-conversation follow-up that
        // continueTask reopens and the still-waiting agents pick up without restarting their sessions.
        // The continuation window in teamActivity keeps them from idling out before that follow-up.
        this.db.prepare(`
          UPDATE agents SET status = 'waiting', current_task_id = NULL, last_seen = ?
          WHERE (current_task_id = ? OR id IN (SELECT agent_id FROM approvals WHERE task_id = ?)) AND status != 'disconnected'
        `).run(stamp, taskId, taskId);
      } else {
        this.db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(stamp, taskId);
      }
      outcome = { accepted, approvalCount, requiredApprovals: effectiveRequired, configuredApprovals: task.required_approvals, openAssignments, version: task.version, selfReviewed };
    });
    this._changed(outcome.accepted ? "task.accepted" : "task.approved", taskId);
    return outcome;
  },

  // A reviewer that finds problems used to have two moves, and both were wrong. Approving anyway is
  // dishonest; `status=blocked` closes the *reviewer's own* assignment and queues a coarse planner
  // item, so the fix routes through a human-shaped triage step instead of back to the person who
  // wrote the code. This is the third move: send the work itself back to its author, with the
  // findings attached, without stopping the task or disturbing anyone else's claim.
  //
  // What it deliberately does NOT do: create a new assignment. The original row is reopened, so its
  // title, description, checklist, write scope, dependencies and whole event history stay attached
  // to the work rather than being scattered across a chain of near-duplicate follow-ups. Reopening
  // clears the claim and its fencing token exactly as a force-release does, so a late report from
  // the author's previous session is refused instead of landing on top of the rework.
  requestChanges({ agentId = null, taskId, assignmentId, summary, findings = [] }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    if (["blocked", "cancelled", "accepted"].includes(task.status)) {
      throw new Error(`Cannot request changes on a ${task.status} task.`);
    }
    const agent = agentId ? this.getAgent(agentId) : null;
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, taskId);
    if (!assignment) throw new Error("Assignment not found in this task room.");
    if (assignment.status !== "done") {
      throw new Error(`Only completed work can be sent back for changes; this assignment is ${assignment.status}.`);
    }
    const cleanSummary = String(summary || "").trim();
    if (!cleanSummary) throw new Error("Say what needs to change.");
    // Earning the right to send work back is the same act as earning the right to approve it: an
    // independent read-only verifier assignment on the current version. The alternative is holding
    // that verifier claim right now — the reviewer that finds the problem mid-review should not have
    // to finish and file its own report before it can say so.
    if (agentId && !this._hasReviewStanding(agentId, taskId, task.version)) {
      throw new Error("Requesting changes needs a completed or in-progress read-only reviewer or tester assignment on the current task version.");
    }
    const cleanFindings = (Array.isArray(findings) ? findings : []).slice(0, 50).map((item) => {
      const isObject = item && typeof item === "object" && !Array.isArray(item);
      return {
        detail: String((isObject ? item.detail : item) ?? "").trim().slice(0, 2000),
        path: isObject && item.path ? String(item.path).trim().slice(0, 500) : null,
      };
    }).filter((item) => item.detail);
    const authorName = assignment.agent_id
      ? (this.db.prepare("SELECT name FROM agents WHERE id = ?").get(assignment.agent_id)?.name || null)
      : null;
    let outcome;
    this._transaction(() => {
      const stamp = now();
      const reworkCount = Number(assignment.rework_count || 0) + 1;
      // Back to queued, addressed to whoever wrote it. Targeting is a preference, not a lock: the
      // existing scheduler rule returns a targeted item to the general queue once nobody by that
      // name is connected, so rework never becomes unclaimable because its author went home.
      this.db.prepare(`
        UPDATE assignments
        SET status = 'queued', agent_id = NULL, completed_at = NULL, claim_token_hash = NULL,
            target_agent_name = COALESCE(?, target_agent_name),
            rework_count = ?, rework_requested_at = ?, rework_summary = ?
        WHERE id = ?
      `).run(authorName, reworkCount, stamp, cleanSummary, assignmentId);
      for (const finding of cleanFindings) {
        this.db.prepare(`
          INSERT INTO assignment_findings (id, assignment_id, task_id, requested_by_agent_id, requested_by_name, task_version, detail, path, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), assignmentId, taskId, agentId, agent?.name || "the human", Number(task.version), finding.detail, finding.path, stamp);
      }
      // The version under review was just judged not good enough, so approvals built on it no longer
      // describe a settled state. Clearing them is the same principle as version-invalidates-
      // approvals: if the rework changes files the version bumps and they would have gone anyway,
      // and if it changes none they would otherwise have survived a reviewer saying "not yet".
      const clearedApprovals = this.db.prepare("DELETE FROM approvals WHERE task_id = ? AND version = ?").run(taskId, task.version).changes;
      this._event(taskId, agentId, "assignment.changes_requested",
        `${agent?.name || "The human"} sent “${assignment.title}” back for changes: ${cleanSummary}`, {
          assignmentId,
          role: assignment.role,
          author: authorName,
          version: Number(task.version),
          reworkCount,
          clearedApprovals,
          findings: cleanFindings,
        });
      this._syncTaskStatus(taskId, stamp);
      outcome = {
        changesRequested: true,
        taskId,
        assignmentId,
        title: assignment.title,
        routedTo: authorName,
        reworkCount,
        clearedApprovals,
        findings: cleanFindings,
        version: Number(task.version),
      };
    });
    this._changed("assignment.changes_requested", taskId);
    return {
      ...outcome,
      next: outcome.routedTo
        ? `“${outcome.title}” is queued again and addressed to ${outcome.routedTo}. It stays claimable by the rest of the room if they are not connected.`
        : `“${outcome.title}” is queued again for whoever picks it up.`,
    };
  },

  // Whether this agent has earned a say on the current version: it either completed a read-only
  // verifier assignment on it (the same evidence approveTask requires) or is holding one right now.
  _hasReviewStanding(agentId, taskId, version) {
    const holding = this.db.prepare(`
      SELECT 1 FROM assignments
      WHERE task_id = ? AND agent_id = ? AND status = 'claimed' AND requires_write = 0
        AND ${VERIFIES} LIMIT 1
    `).get(taskId, agentId);
    if (holding) return true;
    return this.db.prepare(`
      SELECT metadata FROM events
      WHERE task_id = ? AND agent_id = ? AND type = 'assignment.completed'
      ORDER BY id DESC
    `).all(taskId, agentId).some((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === version
        && this._assignmentVerifies(metadata.assignmentId)
        && (!Array.isArray(metadata.changedFiles) || metadata.changedFiles.length === 0);
    });
  },

  // Outstanding findings for an assignment: what the author is being asked to fix. Resolved rows are
  // kept so the history of a reworked piece of work stays legible.
  _findingsFor(assignmentId, { includeResolved = false } = {}) {
    return this.db.prepare(`
      SELECT id, requested_by_name, task_version, detail, path, created_at, resolved_at
      FROM assignment_findings
      WHERE assignment_id = ?${includeResolved ? "" : " AND resolved_at IS NULL"}
      ORDER BY created_at ASC, rowid ASC
    `).all(assignmentId);
  },
};
