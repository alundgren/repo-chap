/* global document */
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { chromium, webkit } from "@playwright/test";

const root = dirname(fileURLToPath(import.meta.url));
const diagnostics = await mkdtemp(join(tmpdir(), "repo-chap-presentation-"));
const artifact = await readFile(join(root, "presentation.html"));
const policy = ["default-src 'none'", "script-src 'unsafe-inline' blob:", "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data: blob:", "media-src data: blob:", "worker-src blob:", "connect-src 'none'", "object-src 'none'", "frame-src blob:", "form-action 'none'", "base-uri 'none'"].join("; ");
// Check that the presentation remains usable offline in an isolated iframe.
const wrapper = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style></head><body><iframe title="Presentation artifact" sandbox="allow-scripts allow-downloads"></iframe><script>const bytes=Uint8Array.from(atob("${artifact.toString("base64")}"),c=>c.charCodeAt(0));document.querySelector("iframe").src=URL.createObjectURL(new Blob([bytes],{type:"text/html"}));</script></body></html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": policy });
  response.end(wrapper);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const errors = [];
let currentBrowser;
try {
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    currentBrowser = await engine.launch({ headless: true });
    const page = await currentBrowser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    page.on("pageerror", error => errors.push(`${name}: ${error.message}`));
    const externalRequests = [];
    page.on("request", request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(address)) externalRequests.push(request.url());
    });
    await page.goto(address);
    const frame = page.frameLocator("iframe");
    await frame.locator("#next").waitFor();
    assert.equal(await frame.locator(".slide").count(), 22);
    assert.match(await frame.locator(".slide.active h1").innerText(), /Keep the PR moving/);
    const go = async title => {
      await frame.locator("#contents-open").click();
      await frame.locator("#contents-list button").filter({ hasText: title }).click();
    };
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await go("The idea");
      for (let i = 0; i < 22; i++) {
        assert.equal(await frame.locator(".slide.active").count(), 1);
        const layout = await frame.locator(".slide.active").evaluate(element => ({
          width: element.clientWidth, scroll: element.scrollWidth,
          documentWidth: document.documentElement.clientWidth, documentScroll: document.documentElement.scrollWidth,
        }));
        assert.ok(layout.scroll <= layout.width + 1, `${name} slide ${i + 1} overflows at ${viewport.width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.documentScroll <= layout.documentWidth + 1, "Presentation page scrolls horizontally");
        if (viewport.width === 1280 && [0, 4, 5, 7, 8].includes(i)) {
          await page.screenshot({ path: join(diagnostics, `${name}-slide-${i + 1}.png`) });
        }
        if (i < 21) await frame.locator("#next").click();
      }
      await go("Interactive visual editor");
      await frame.locator('[data-action="address"]').click();
      assert.equal(await frame.locator("#action-title").innerText(), "Address review");
      assert.match(await frame.locator("#action-permissions").innerText(), /workspace.write/);
      await frame.locator("#review-wait").fill("600");
      await frame.locator('[data-scenario="pending"]').click();
      await frame.locator("#simulate").click();
      assert.match(await frame.locator("#trace-output").innerText(), /600-second timer/);
      await page.screenshot({ path: join(diagnostics, `${name}-editor-${viewport.width}.png`) });
    }
    await frame.locator("#source-tab").click();
    const original = await frame.locator("#workflow-source").inputValue();
    await frame.locator("#workflow-source").fill("{");
    await frame.locator("#validate-source").click();
    assert.equal(await frame.locator("#export-editor").isDisabled(), true);
    await frame.locator("#graph-tab").click();
    assert.equal(await frame.locator("#source-view").isVisible(), true);
    const changed = JSON.parse(original);
    changed.settings.mergeMode = "automatic";
    await frame.locator("#workflow-source").fill(JSON.stringify(changed));
    await frame.locator("#validate-source").click();
    assert.match(await frame.locator("#editor-status").innerText(), /human merge/);
    changed.settings.mergeMode = "human";
    changed.settings.reviewWaitSeconds = 450;
    const conflictIndex = changed.rules.findIndex(rule => rule.id === "conflict");
    const reviewIndex = changed.rules.findIndex(rule => rule.id === "review_to_address");
    [changed.rules[conflictIndex], changed.rules[reviewIndex]] = [changed.rules[reviewIndex], changed.rules[conflictIndex]];
    await frame.locator("#workflow-source").fill(JSON.stringify(changed));
    await frame.locator("#validate-source").click();
    assert.equal(await frame.locator("#export-editor").isEnabled(), true);
    const downloadEvent = page.waitForEvent("download");
    await frame.locator("#export-editor").click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), "workflow.json");
    const saved = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.equal(saved.settings.reviewWaitSeconds, 450);
    assert.equal(saved.settings.mergeMode, "human");
    await frame.locator("#graph-tab").click();
    assert.equal(await frame.locator("#workflow-path .node").first().getAttribute("data-action"), "address");
    await frame.locator('[data-scenario="conflict"]').click();
    await frame.locator("#simulate").click();
    assert.match(await frame.locator("#trace-output").innerText(), /review_to_address → address/);
    await frame.locator("#reset-editor").click();
    assert.equal(await frame.locator("#review-wait").inputValue(), "300");
    await frame.locator('[data-scenario="conflict"]').click();
    await frame.locator("#simulate").click();
    assert.match(await frame.locator("#trace-output").innerText(), /conflict → resolve_conflict/);
    await frame.locator('[data-scenario="ready"]').click();
    await frame.locator("#simulate").click();
    assert.match(await frame.locator("#trace-output").innerText(), /person merges/);
    await go("Speed and cost control");
    await frame.locator("#cost-prs").fill("10");
    assert.equal(await frame.locator("#cost-total").innerText(), "60 units / day");
    await frame.locator("#reading-toggle").click();
    assert.equal(await frame.locator(".slide:visible").count(), 22);
    await frame.locator("#reading-toggle").click();
    assert.equal(await frame.locator(".slide:visible").count(), 1);
    assert.deepEqual(externalRequests, [], "The offline presentation made external requests");
    await currentBrowser.close();
    currentBrowser = undefined;
  }
  assert.deepEqual(errors, [], "Browser script errors");
  process.stdout.write("PASS presentation: Chromium + WebKit, 22 slides at 3 viewport sizes, editor, simulation, recovery, export, offline sandbox\n");
} catch (error) {
  await writeFile(join(diagnostics, "failure.txt"), `${error.stack}\n${errors.join("\n")}`);
  process.stderr.write(`FAIL presentation: ${error.message}\nDiagnostics: ${diagnostics}\n`);
  process.exitCode = 1;
} finally {
  if (currentBrowser) await currentBrowser.close();
  await new Promise(resolve => server.close(resolve));
}
