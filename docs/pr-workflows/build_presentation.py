#!/usr/bin/env python3
"""Build an offline HTML presentation from maintained source and local assets."""

import base64
import html
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FONTS = ROOT / "assets/fonts"


def esc(value):
    return html.escape(str(value), quote=True)


class Drawing:
    def __init__(self, title, width=1120, height=540):
        self.marker_id = "arrow-" + hashlib.sha256(title.encode()).hexdigest()[:8]
        self.items = [
            f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{esc(title)}" xmlns="http://www.w3.org/2000/svg">',
            f"<title>{esc(title)}</title>",
            f'<defs><marker id="{self.marker_id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="var(--link)"/></marker></defs>',
        ]

    def box(self, x, y, w, h, label, detail, role="system"):
        fill = "var(--raised)" if role == "main" else "var(--surface)"
        if role == "person":
            fill = "var(--field)"
        self.items.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="var(--line)"/>')
        self.items.append(f'<text x="{x+w/2}" y="{y+27}" text-anchor="middle" font-size="18" font-weight="600">{esc(label)}</text>')
        for index, line in enumerate(detail.split("|")):
            self.items.append(f'<text x="{x+w/2}" y="{y+49+index*20}" text-anchor="middle" font-size="14">{esc(line)}</text>')

    def arrow(self, points, label, tx, ty):
        coords = " ".join(f"{x},{y}" for x, y in points)
        self.items.append(f'<polyline points="{coords}" fill="none" stroke="var(--link)" stroke-width="1.8" marker-end="url(#{self.marker_id})"/>')
        self.items.append(f'<text x="{tx}" y="{ty}" text-anchor="middle" class="edge-label" font-size="13">{esc(label)}</text>')

    def line(self, x, y, x2, y2):
        self.items.append(f'<line x1="{x}" y1="{y}" x2="{x2}" y2="{y2}" stroke="var(--line)" stroke-dasharray="5 5"/>')

    def finish(self):
        return "".join(self.items) + "</svg>"


def context():
    d = Drawing("C4 context: engineer, team, workflow service, GitHub, model provider and messaging")
    d.box(30, 45, 230, 90, "Engineer", "Authors and tests processes", "person")
    d.box(425, 45, 270, 90, "Team reviewer", "Reads evidence; merges PRs", "person")
    d.box(425, 220, 270, 100, "PR workflow service", "[Software system]|Observes, decides, repairs", "main")
    d.box(830, 45, 260, 90, "GitHub", "[External system]|PR facts, source, branch policy")
    d.box(30, 370, 250, 90, "Local Electron app", "[Application]|Edit and simulate files")
    d.box(425, 420, 270, 90, "Model provider", "[External system]|Codex or Claude inference")
    d.box(830, 370, 260, 90, "Messaging", "[Optional external system]|Decision packet delivery")
    d.arrow([(260,90),(340,90),(340,250),(425,250)], "Trusted files", 339, 183)
    d.arrow([(560,135),(560,220)], "Read current decisions", 560, 178)
    d.arrow([(695,90),(830,90)], "Human merge", 761, 77)
    d.arrow([(695,243),(960,243),(960,135)], "Read / permitted effects", 834, 230)
    d.arrow([(880,135),(880,286),(695,286)], "Poll responses", 785, 272)
    d.arrow([(280,415),(340,415),(340,290),(425,290)], "Workflow files", 340, 352)
    d.arrow([(560,320),(560,420)], "Bounded inference", 560, 376)
    d.arrow([(695,305),(770,305),(770,415),(830,415)], "Notify", 770, 360)
    return d.finish()


def containers():
    d = Drawing("C4 containers: private editor, control daemon, durable store, effect broker, isolated worker and tests", height=570)
    d.box(25, 60, 230, 90, "CLI on the VM", "[Application]|Operate the daemon")
    d.box(420, 60, 270, 90, "Control daemon", "[Application]|Observe, decide, schedule", "main")
    d.box(865, 60, 230, 90, "Durable store", "[SQLite database]|Leases, timers, budgets")
    d.box(25, 300, 230, 90, "Private artifacts", "[File store]|Packages, results, notes")
    d.box(420, 300, 270, 90, "Agent worker", "[Bounded process]|CLI + disposable checkout")
    d.box(865, 300, 230, 90, "Effect broker", "[Host service]|Validate grants; remote writes")
    d.box(420, 480, 270, 80, "Test worker", "Checks on the exact candidate")
    d.box(865, 480, 230, 80, "GitHub / messaging", "Named effects only")
    d.arrow([(255,105),(420,105)], "Local socket", 337, 92)
    d.arrow([(690,105),(865,105)], "Transactions", 775, 92)
    d.arrow([(500,150),(500,300)], "Dispatch / validate output", 500, 228)
    d.arrow([(140,300),(140,235),(450,235),(450,150)], "Pinned input / artifacts", 269, 221)
    d.arrow([(690,130),(760,130),(760,345),(865,345)], "Committed effect request", 877, 214)
    d.arrow([(980,300),(980,150)], "Check lease + receipts", 980, 247)
    d.arrow([(555,390),(555,480)], "Run required checks", 555, 441)
    d.arrow([(980,390),(980,480)], "Recheck then apply", 980, 441)
    return d.finish()


def components():
    d = Drawing("C4 components of the control daemon", height=470)
    d.box(25, 50, 270, 95, "Signal intake", "[Component]|Polling and durable timers")
    d.box(425, 50, 270, 95, "Observation collector", "[Component]|Pinned facts and coverage")
    d.box(825, 50, 270, 95, "Rule evaluator", "[Component]|Pure first-match decision", "main")
    d.box(25, 310, 270, 95, "Process registry", "[Component]|Immutable approved packages")
    d.box(425, 310, 270, 95, "Result validator", "[Component]|Schema + evidence checks")
    d.box(825, 310, 270, 95, "Attempt scheduler", "[Component]|Lease, reserve, dispatch")
    d.arrow([(295,97),(425,97)], "Refresh", 360, 84)
    d.arrow([(695,97),(825,97)], "Facts", 760, 84)
    d.arrow([(960,145),(960,310)], "Decision", 960, 232)
    d.arrow([(825,357),(695,357)], "Worker result", 760, 344)
    d.arrow([(425,380),(355,380),(355,220),(160,220),(160,145)], "Reobserve / wait", 276, 207)
    d.arrow([(295,333),(390,333),(390,185),(860,185),(860,145)], "Pinned process", 610, 174)
    return d.finish()


def state_machine():
    d = Drawing("Execution state machine with waits, effect reconciliation and human handoff", height=520)
    for x, label, detail in [(20,"Observe","Fresh PR facts"),(300,"Decide","Ordered rules"),(580,"Run","Bounded action"),(860,"Validate","Typed evidence")]:
        d.box(x, 70, 240, 80, label, detail, "main" if label=="Decide" else "system")
    for x, label, detail in [(20,"Wait","Timer or new signal"),(300,"Human","Decision or blocked work"),(580,"Reconcile","Unknown remote result"),(860,"Apply","Broker checks policy")]:
        d.box(x, 360, 240, 80, label, detail)
    d.arrow([(260,110),(300,110)], "", 280, 100)
    d.arrow([(540,110),(580,110)], "", 560, 100)
    d.arrow([(820,110),(860,110)], "", 840, 100)
    d.arrow([(980,150),(980,360)], "Effect requested", 980, 252)
    d.arrow([(860,400),(820,400)], "", 840, 390)
    d.arrow([(700,360),(700,260),(140,260),(140,150)], "Confirmed / rejected: fresh observation", 414, 248)
    d.arrow([(420,150),(420,360)], "Needs decision", 420, 207)
    d.arrow([(360,150),(360,205),(200,205),(200,360)], "Wait", 216, 329)
    d.arrow([(75,360),(75,150)], "Due / signal", 77, 220)
    return d.finish()


def sequence():
    d = Drawing("Sequence: an autonomous repair, conditional push and stale-head rejection", height=610)
    xs=[110,335,560,785,1010]
    for x,label in zip(xs,["GitHub","Daemon","Store","Worker","Broker"]):
        d.box(x-90, 15, 180, 60, label, "")
        d.line(x,75,x,600)
    events=[(1,0,"Poll current PR facts"),(1,2,"Claim PR + reserve budget"),(1,0,"Read head H1 and review evidence"),(1,3,"Dispatch pinned repair"),(3,1,"Candidate H2 + evidence"),(1,2,"Commit validated push request"),(1,4,"Apply committed effect"),(4,0,"Re-read ref; compare with H1"),(4,0,"Conditional fast-forward to H2"),(4,2,"Receipt or unknown outcome"),(1,0,"Reobserve before resolving threads")]
    for i,(a,b,label) in enumerate(events):
        y=110+i*43
        d.arrow([(xs[a],y),(xs[b],y)],label,(xs[a]+xs[b])/2,y-9)
    return d.finish()


def build():
    source=(ROOT/"presentation.template.html").read_text()
    fonts=[]
    for name,family,weight in [
        ("IBMPlexSans-Regular.woff2","IBM Plex Sans",400),
        ("IBMPlexSans-SemiBold.woff2","IBM Plex Sans",600),
        ("IBMPlexMono-Regular.woff2","IBM Plex Mono",400),
    ]:
        encoded=base64.b64encode((FONTS/name).read_bytes()).decode()
        fonts.append(f'@font-face{{font-family:"{family}";font-style:normal;font-weight:{weight};src:url(data:font/woff2;base64,{encoded}) format("woff2");font-display:swap;}}')
    workflow=json.loads((ROOT/"examples/team-pr/workflow.json").read_text())
    replacements={
        "FONTS":"\n".join(fonts),
        "FONT_LICENSE":esc("\n".join(line.rstrip() for line in (FONTS/"OFL.txt").read_text().splitlines())),
        "WORKFLOW":json.dumps(workflow,ensure_ascii=False).replace("<","\\u003c"),
        "CONTEXT":context(),"CONTAINERS":containers(),"COMPONENTS":components(),
        "STATE_MACHINE":state_machine(),"SEQUENCE":sequence(),
    }
    for key,value in replacements.items():
        source=source.replace("@@"+key+"@@",value)
    if "@@" in source:
        raise ValueError("Unresolved template marker")
    (ROOT/"presentation.html").write_text(source)
    print(f"PASS presentation built, {len(source.encode()):,} bytes")


if __name__ == "__main__":
    build()
