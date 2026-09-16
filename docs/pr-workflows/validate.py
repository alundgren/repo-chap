#!/usr/bin/env python3
"""Check the proposal's actual examples, references, and offline artifact."""

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
    sys.exit("Install jsonschema==4.19.2 in an isolated environment; see contracts.md")

ROOT = Path(__file__).resolve().parent


def read_json(path):
    return json.loads(path.read_text())


def check(condition, message):
    if not condition:
        raise ValueError(message)


class ArtifactParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.slide_count = 0
        self.diagrams = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            check(attrs["id"] not in self.ids, f"Duplicate HTML ID: {attrs['id']}")
            self.ids.add(attrs["id"])
        if "src" in attrs:
            check(attrs["src"].startswith(("data:", "blob:")), "External artifact asset")
        if tag == "section" and "slide" in attrs.get("class", "").split():
            self.slide_count += 1
        if tag == "svg":
            self.diagrams += 1
            check(bool(attrs.get("aria-label")), "Architecture drawing needs an accessible name")


def main():
    process_schema = read_json(ROOT / "schemas/workflow.schema.json")
    result_schema = read_json(ROOT / "schemas/results.schema.json")
    Draft202012Validator.check_schema(process_schema)
    Draft202012Validator.check_schema(result_schema)
    process = read_json(ROOT / "examples/team-pr/workflow.json")
    Draft202012Validator(process_schema).validate(process)
    examples = {
        "review": "review", "classification": "classification", "candidate": "candidate",
        "blocked-repair": "candidate", "decision-packet": "decisionPacket", "state": "controlState",
    }
    for name, definition in examples.items():
        schema = {**result_schema, "$ref": f"#/$defs/{definition}"}
        value = read_json(ROOT / f"examples/results/{name}.json")
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)
        for finding in value.get("findings", []):
            for evidence in finding["evidence"]:
                check(evidence["startLine"] <= evidence["endLine"], "Reversed source location")
    action_ids = set(process["actions"])
    continuations = action_ids | {"$observe", "$wait", "$closed", "$blocked"}
    check(len({r["id"] for r in process["rules"]}) == len(process["rules"]), "Duplicate rule ID")
    for rule in process["rules"]:
        check(rule["action"] in action_ids, f"Unknown rule action: {rule['action']}")
    check(process["otherwise"] in action_ids, "Unknown fallback action")
    check("pr.merge" not in process["requestedCapabilities"], "V1 must not grant merge")
    check(process["settings"]["reviewWaitSeconds"] <= process["settings"]["reviewDeadlineSeconds"], "Wait exceeds deadline")
    check("repair_waiting_human" in {r["id"] for r in process["rules"]}, "Missing unchanged-concern suppression")
    for action in process["actions"].values():
        check(set(action["capabilities"]) <= set(process["requestedCapabilities"]), "Action exceeds requested grant")
        check(action["onSuccess"] in continuations and action["onFailure"] in continuations, "Unknown continuation")
        for field in ("prompt", "outputSchema"):
            if field not in action:
                continue
            filename, _, fragment = action[field].partition("#")
            target = (ROOT / "examples/team-pr" / filename).resolve()
            check(target.is_relative_to(ROOT) and target.is_file(), f"Invalid local {field} reference")
            if fragment:
                value = read_json(target)
                for segment in fragment.lstrip("/").split("/"):
                    value = value[segment]
        for context in action.get("contextFiles", []):
            target = (ROOT / "examples/team-pr" / context).resolve()
            check(target.is_relative_to(ROOT) and target.is_file(), "Invalid context file")
        if action["execution"] == "agent":
            check("prompt" in action and "outputSchema" in action, "Agent action missing contract")
    for markdown in ROOT.rglob("*.md"):
        for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", markdown.read_text()):
            if "://" in target or target.startswith("#"):
                continue
            path = (markdown.parent / target.split("#")[0]).resolve()
            check(path.exists(), f"Broken local link in {markdown.name}: {target}")
    output = ROOT / "presentation.html"
    artifact = output.read_text()
    check(output.stat().st_size < 10 * 1024 * 1024, "Presentation exceeds its 10 MiB size budget")
    check("@@" not in artifact, "Unresolved build marker")
    check("data:font/woff2;base64," in artifact and "SIL OPEN FONT LICENSE" in artifact, "Missing embedded fonts/licence")
    parser = ArtifactParser()
    parser.feed(artifact)
    check(parser.slide_count == 22 and parser.diagrams == 5, "Missing slides or architecture drawings")
    embedded = re.search(r'<script id="initial-workflow" type="application/json">(.*?)</script>', artifact, re.S)
    check(embedded is not None and json.loads(embedded.group(1)) == process, "Rebuild the presentation after changing workflow.json")
    print(f"PASS document contracts, {len(examples)} result examples, references, 22 slides, 5 diagrams, offline assets")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit(f"FAIL {error}")
