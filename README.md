# Email Redactor - GitHub Pages version

This is a static browser-based email redaction tool. It can be hosted on GitHub Pages because it uses only HTML, CSS and browser JavaScript.

## Supported files

- `.eml`
- `.msg`
- `.docx`
- `.doc`
- `.txt`
- `.html`
- `.htm`
- `.csv`
- `.log`
- `.md`

Outlook `.msg`, modern Word `.docx`, and legacy Word `.doc` files are parsed in-browser. Legacy `.doc` parsing uses best-effort text extraction from the Word binary file, so very old or damaged documents may need to be saved as `.docx`, `.txt`, or `.html` first. PDF and spreadsheet extraction are intentionally not included in this static browser version because reliable parsing/redaction for those formats needs a backend or desktop runtime. Save spreadsheets as `.csv` or use the Electron desktop version.

The file picker is intentionally not restricted with an `accept` filter, because some browsers and managed Windows environments hide Outlook `.msg` files incorrectly. The app still validates files after selection and skips unsupported files such as `.pdf`, `.xlsx`, images and other binary formats with a clear error message instead of treating them as broken text.

## Features

- Bulk upload.
- Detects standard email addresses.
- Detects `mailto:` addresses.
- Detects common obfuscated forms such as `name [at] domain [dot] org`.
- Extracts readable text from Outlook `.msg` messages and Word `.docx` / `.doc` documents.
- Select all, select none, select only To/Cc/Bcc, or select body emails.
- Optional safety-net redaction at export time.
- Removes selected email addresses from To, Cc and Bcc metadata fields instead of replacing them with redaction text.
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


## Export behaviour

For email files, To/Cc/Bcc recipient header lines are omitted from exported TXT/PDF copies to avoid long recipient lists. Recipient email addresses are still detected for review and included in the redaction audit where applicable.
