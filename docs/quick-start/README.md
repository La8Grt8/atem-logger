# Quick start guide source

`guide.html` + `ui.png` are the source of `../ATEM-Logger-Quick-Start.pdf` (US Letter).

To rebuild after editing, print `guide.html` to PDF with Chromium/Chrome with background graphics on,
or with Playwright:

```js
const p = await (await chromium.launch()).newPage();
await p.goto('file://' + path.resolve('guide.html'), { waitUntil: 'networkidle' });
await p.pdf({ path: '../ATEM-Logger-Quick-Start.pdf', format: 'Letter', preferCSSPageSize: true, printBackground: true });
```

`ui.png` is a 2x screenshot of the control page (1180x505 CSS px viewport).
