"""
DSIR R&D 2025 PDF Extractor
Reads the DSIR directory PDF, extracts all company entries, and writes
them to a new Google Sheet.

Setup (one-time):
  pip install pymupdf gspread google-auth-oauthlib

  Get credentials.json:
  1. console.cloud.google.com → same Google account you use for Sheets
  2. APIs & Services → Enable: Google Sheets API + Google Drive API
  3. Credentials → Create → OAuth 2.0 Client ID → Desktop app → Download
  4. Rename to credentials.json, place in this folder
"""

import os
import re
import json
import fitz  # pymupdf
import gspread
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request

PDF_PATH = os.path.join(os.path.dirname(__file__), "DSIR R&D 2025.pdf")
CREDS_FILE = os.path.join(os.path.dirname(__file__), "credentials.json")
TOKEN_FILE = os.path.join(os.path.dirname(__file__), "token.json")
SHEET_NAME = "DSIR R&D 2025 - Company List"

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

# Legal suffixes that end a company name (order matters — longer first)
LEGAL_SUFFIX_PATTERN = re.compile(
    r"^(.*?(?:"
    r"Pvt\.\s+Ltd\."
    r"|Private\s+Limited"
    r"|Co\.\s+Ltd\."
    r"|Ltd\."
    r"|Limited"
    r"|Corporation"
    r"|Corp\."
    r"|LLP"
    r"|Inc\."
    r"))",
    re.IGNORECASE | re.DOTALL,
)

STATE_PATTERN = re.compile(r"\(([A-Za-z\s]+)\)\s*$")


def get_gspread_client():
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return gspread.authorize(creds)


def parse_company_name(raw: str) -> str:
    """Extract company name from a combined Name+Address cell."""
    # Normalize: join lines with space, collapse multiple spaces
    text = re.sub(r"\s+", " ", raw.replace("\n", " ")).strip()
    m = LEGAL_SUFFIX_PATTERN.match(text)
    if m:
        return m.group(1).strip()
    # Fallback: everything before the first comma (catches PSUs with no Ltd.)
    return text.split(",")[0].strip()


def parse_state(raw: str) -> str:
    """Extract state from the last parenthetical in the address."""
    text = re.sub(r"\s+", " ", raw.replace("\n", " ")).strip()
    # Remove PIN codes (6-digit numbers) so we don't match city codes
    text = re.sub(r"\b\d{6}\b", "", text).strip()
    m = STATE_PATTERN.search(text)
    if m:
        candidate = m.group(1).strip()
        # Filter out things that look like city names or single words that aren't states
        if len(candidate) > 3:
            return candidate
    # Fallback: scan all parentheticals, return last multi-word or known state
    all_parens = re.findall(r"\(([A-Za-z][A-Za-z\s]{3,})\)", text)
    if all_parens:
        return all_parens[-1].strip()
    return ""


def extract_companies(pdf_path: str) -> list[dict]:
    pdf = fitz.open(pdf_path)
    companies = []
    skipped_pages = []

    print(f"Processing {pdf.page_count} pages...")

    for page_num in range(pdf.page_count):
        page = pdf[page_num]
        try:
            tabs = page.find_tables()
            if not tabs.tables:
                continue
            for table in tabs.tables:
                rows = table.extract()
                for row in rows:
                    if not row or len(row) < 5:
                        continue
                    sno = str(row[0] or "").strip()
                    # Only process numbered data rows (skip headers/footers)
                    if not re.match(r"^\d+\.?$", sno):
                        continue

                    recog_num = str(row[1] or "").strip()
                    name_addr = str(row[2] or "")
                    valid_upto = str(row[4] or "").strip()

                    company_name = parse_company_name(name_addr)
                    state = parse_state(name_addr)

                    companies.append({
                        "S.No.": sno.rstrip("."),
                        "Recognition Number": recog_num,
                        "Company Name": company_name,
                        "State": state,
                        "Valid Upto": valid_upto,
                        "Website": "",
                    })
        except Exception as e:
            skipped_pages.append((page_num + 1, str(e)))

    if skipped_pages:
        print(f"Warning: {len(skipped_pages)} pages had errors:")
        for pg, err in skipped_pages[:5]:
            print(f"  Page {pg}: {err}")

    print(f"Extracted {len(companies)} companies.")
    return companies


def write_to_sheet(companies: list[dict], gc: gspread.Client) -> str:
    print(f"Creating Google Sheet: '{SHEET_NAME}'...")
    sh = gc.create(SHEET_NAME)
    ws = sh.sheet1
    ws.update_title("Companies")

    headers = ["S.No.", "Recognition Number", "Company Name", "State", "Valid Upto", "Website"]
    rows = [headers] + [
        [c["S.No."], c["Recognition Number"], c["Company Name"],
         c["State"], c["Valid Upto"], c["Website"]]
        for c in companies
    ]

    # Write in one batch call
    ws.update(rows, "A1")

    # Bold header row
    ws.format("A1:F1", {"textFormat": {"bold": True}})

    # Freeze header
    sh.batch_update({
        "requests": [{
            "updateSheetProperties": {
                "properties": {"sheetId": ws.id, "gridProperties": {"frozenRowCount": 1}},
                "fields": "gridProperties.frozenRowCount",
            }
        }]
    })

    url = f"https://docs.google.com/spreadsheets/d/{sh.id}"
    print(f"Done! Sheet URL: {url}")
    return url


def main():
    if not os.path.exists(PDF_PATH):
        raise FileNotFoundError(f"PDF not found: {PDF_PATH}")
    if not os.path.exists(CREDS_FILE):
        raise FileNotFoundError(
            "credentials.json not found. See setup instructions at the top of this file."
        )

    companies = extract_companies(PDF_PATH)

    gc = get_gspread_client()
    url = write_to_sheet(companies, gc)

    print(f"\nSheet created: {url}")
    print("Next step: run dsir_website_lookup.py to fill in the Website column.")


if __name__ == "__main__":
    main()
