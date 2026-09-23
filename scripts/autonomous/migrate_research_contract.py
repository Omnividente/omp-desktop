#!/usr/bin/env python3
"""Preview a research schema upgrade, or publish it under the queue-writer lock."""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from complete_jules_task import atomic_write
from lab_controller import GitHub
from proposal_backlog import authorize
from research_request import CONTRACT_VERSION, migrate_legacy
from state_store import load_state, save_state
from validate_tasks import validate


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--actor", required=True)
    parser.add_argument("--note", required=True)
    parser.add_argument("--publish", action="store_true",
                        help="Publish to autonomous/state; only the owner workflow may hold the writer lock")
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--revision-file", type=Path)
    parser.add_argument("--expected-state-sha", default="")
    parser.add_argument("--summary-out", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        actor = authorize(config, args.actor)
        if not args.note.strip():
            raise ValueError("migration requires a nonblank owner note")
        if args.manifest.resolve() == args.out.resolve():
            raise ValueError("migration output must not overwrite its input")
        if args.publish:
            if (os.environ.get("GITHUB_WORKFLOW") != "Autonomous Research Contract Migration"
                    or os.environ.get("GITHUB_REF") != "refs/heads/main"
                    or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
                    or os.environ.get("GITHUB_REPOSITORY") != config["repository"]
                    or actor.casefold() != os.environ.get("GITHUB_ACTOR", "").casefold()):
                raise ValueError("publication requires the guarded owner workflow on main")
            if not args.repo or not args.revision_file or not args.expected_state_sha:
                raise ValueError("publication requires repo, revision-file and expected-state-sha")
            github = GitHub(config["repository"])
            if github.enabled():
                raise ValueError("disable the loop before migrating research state")
            data = load_state(args.repo, args.manifest, args.revision_file)
            revision = json.loads(args.revision_file.read_text(encoding="utf-8"))
            if revision["state_sha"] != args.expected_state_sha:
                raise ValueError("state advanced; review the new revision before migrating")
        else:
            data = json.loads(args.manifest.read_text(encoding="utf-8"))
            revision = {}
        errors = validate(data)
        if errors:
            raise ValueError("invalid pre-migration state: " + "; ".join(errors))
        updated, tagged = migrate_legacy(data)
        errors = validate(updated)
        if errors:
            raise ValueError("invalid migrated state: " + "; ".join(errors))
        atomic_write(args.out, json.dumps(updated, ensure_ascii=False, indent=2) + "\n")
        result = {"contract_version": CONTRACT_VERSION, "published": False, "changed": updated != data,
                  "legacy_attempts": tagged, "actor": actor, "note": args.note.strip(),
                  "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "before_state_sha": revision.get("state_sha")}
        if args.publish:
            if github.enabled():
                raise ValueError("loop was enabled during migration; refusing publication")
            result["state_sha"] = save_state(args.repo, args.out, args.revision_file)
            result["published"] = True
        atomic_write(args.summary_out, json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({key: value for key, value in result.items() if key != "note"}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        # Do not echo worker prompts, owner notes, URLs, or credential-bearing subprocess output.
        print("Research contract migration stopped: " + str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
