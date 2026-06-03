# Email Redactor - GitHub Pages version

This is a static browser-based email redaction tool. It can be hosted on GitHub Pages because it uses only HTML, CSS and browser JavaScript.

## Supported files

- `.eml`
- `.txt`
- `.html`
- `.htm`
- `.csv`
- `.md`

For reliable PDF and Word extraction, use the Electron desktop version. Browser-only PDF extraction is intentionally not included in this static version because true PDF parsing/redaction is not reliable enough without a backend or desktop runtime.

## Features

- Bulk upload.
- Detects standard email addresses.
- Detects `mailto:` addresses.
- Detects common obfuscated forms such as `name [at] domain [dot] org`.
- Select all, select none, select only To/Cc/Bcc, or select body emails.
- Optional safety-net redaction at export time.
- Export individual PDFs in a ZIP.
- Export one combined PDF.
- Export individual redacted TXT files in a ZIP.
- Includes an audit CSV when exporting individual PDFs.

## Privacy

All processing happens in the user's browser. Files are not uploaded to GitHub or any server by this code.

## GitHub Pages deployment

1. Create a new GitHub repository, for example `email-redactor`.
2. Upload these files to the repository root:
   - `index.html`
   - `styles.css`
   - `app.js`
   - `README.md`
3. In GitHub, go to **Settings > Pages**.
4. Under **Build and deployment**, choose:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. Save.
6. GitHub will publish the site at a URL like:
   - `https://YOUR-USERNAME.github.io/email-redactor/`

## Local test

Open `index.html` directly in a browser, or run a simple local server:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```
