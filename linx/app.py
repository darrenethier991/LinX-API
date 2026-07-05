# LinX Smart Lead Qualifier API - v2.0
# Run with: .venv\Scripts\python.exe -m uvicorn app:app --reload --port 8000

import logging
import sys
import pathlib
from datetime import datetime
from typing import Optional

import gspread
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.oauth2.service_account import Credentials
from pydantic import BaseModel
from pydantic_settings import BaseSettings
from sqlalchemy import Column, DateTime, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# --- Local qualifier import ---
ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from smart_qualifier.lead_qualifier import qualify_lead

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("linx")

# --- Settings (.env file) ---
class Settings(BaseSettings):
    LINX_SHEET_ID: str = "YOUR_SHEET_ID_HERE"
    GOOGLE_CREDS_JSON: str = "credentials.json"
    DATABASE_URL: str = "sqlite:///./linx.db"

    class Config:
        env_file = ".env"

settings = Settings()

# --- Google Sheets ---
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

def get_sheet(tab_name: str):
    try:
        creds = Credentials.from_service_account_file(
            settings.GOOGLE_CREDS_JSON, scopes=SCOPES
        )
        client = gspread.authorize(creds)
        sheet = client.open_by_key(settings.LINX_SHEET_ID)
        return sheet.worksheet(tab_name)
    except Exception as e:
        log.warning(f"Google Sheets not connected ({tab_name}): {e}")
        return None

# --- SQLAlchemy (fixed declarative_base deprecation) ---
class Base(DeclarativeBase):
    pass

class LeadRecord(Base):
    __tablename__ = "leads"
    id          = Column(Integer, primary_key=True, autoincrement=True)
    full_name   = Column(String(120))
    email       = Column(String(120))
    phone       = Column(String(40))
    postal_code = Column(String(20))
    category    = Column(String(80))
    budget      = Column(String(40))
    description = Column(Text)
    score       = Column(Integer)
    tier        = Column(String(40))
    status      = Column(String(40), default="New")
    source      = Column(String(40), default="api")
    created_at  = Column(DateTime, default=datetime.utcnow)

engine = create_engine(settings.DATABASE_URL, connect_args={"check_same_thread": False})
Base.metadata.create_all(bind=engine)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

# --- FastAPI app ---
app = FastAPI(
    title="LinX Smart Lead Qualifier API",
    description="Professional lead scoring and contractor matching for LinX",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Pydantic models ---
class LeadInput(BaseModel):
    first_name:          Optional[str]  = None
    last_name:           Optional[str]  = None
    email:               Optional[str]  = None
    phone:               Optional[str]  = None
    postal_code:         Optional[str]  = None
    project_category:    Optional[str]  = None
    estimated_budget:    Optional[str]  = None
    project_description: Optional[str]  = None
    source:              Optional[str]  = "api"
    has_photos:          Optional[bool] = False
    timestamp:           Optional[str]  = None

class ContractorInput(BaseModel):
    name:              str
    business_name:     Optional[str]   = None
    trade:             Optional[str]   = None
    phone:             Optional[str]   = None
    email:             Optional[str]   = None
    service_areas:     Optional[str]   = None
    rating:            Optional[float] = None
    subscription_tier: Optional[str]   = "Standard $49/mo"
    availability:      Optional[str]   = "Available"
    notes:             Optional[str]   = None

class MatchInput(BaseModel):
    homeowner_name:     str
    homeowner_contact:  Optional[str]   = None
    contractor_name:    str
    contractor_contact: Optional[str]   = None
    trade:              Optional[str]   = None
    match_type:         Optional[str]   = "Auto-Matched"
    revenue_generated:  Optional[float] = 0.0
    notes:              Optional[str]   = None

# --- Routes ---

@app.get("/", tags=["General"])
async def root():
    return {
        "service": "LinX Smart Lead Qualifier API",
        "version": "2.0.0",
        "status": "online",
        "docs": "/docs",
        "endpoints": [
            "GET  /",
            "GET  /health",
            "POST /qualify",
            "GET  /leads",
            "GET  /leads/{lead_id}",
            "GET  /contractors",
            "POST /contractors",
            "GET  /applications",
            "GET  /matches",
            "POST /matches",
        ],
    }


@app.get("/health", tags=["General"])
async def health():
    sheet_ok = get_sheet("Homeowner Leads") is not None
    return {
        "status": "healthy",
        "service": "LinX Smart Lead Qualifier",
        "google_sheets": "connected" if sheet_ok else "not connected - check credentials.json and LINX_SHEET_ID in .env",
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/qualify", tags=["Smart Lead Qualifier"])
async def qualify_lead_endpoint(lead: LeadInput):
    log.info(f"Qualifying lead: {lead.first_name} {lead.last_name}")

    try:
        result = qualify_lead(lead.model_dump())
    except Exception as e:
        log.error(f"Qualifier error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    score     = result.get("score", 0)
    tier      = result.get("tier", "Unknown")
    full_name = f"{lead.first_name or ''} {lead.last_name or ''}".strip()
    now       = datetime.utcnow().strftime("%Y-%m-%d %H:%M")

    ws = get_sheet("Homeowner Leads")
    if ws:
        try:
            next_id = len(ws.col_values(1))
            ws.append_row([
                next_id, now, full_name,
                lead.phone or "", lead.email or "",
                "", "",
                lead.postal_code or "",
                lead.project_category or "",
                lead.project_description or "",
                lead.estimated_budget or "",
                "Normal", "New", "", "",
                f"Source: {lead.source} | Photos: {lead.has_photos}",
                score,
            ], value_input_option="USER_ENTERED")
            log.info(f"Lead #{next_id} written to Google Sheets")
        except Exception as e:
            log.warning(f"Sheets write failed (non-fatal): {e}")

    try:
        db = SessionLocal()
        db.add(LeadRecord(
            full_name=full_name, email=lead.email, phone=lead.phone,
            postal_code=lead.postal_code, category=lead.project_category,
            budget=lead.estimated_budget, description=lead.project_description,
            score=score, tier=tier, source=lead.source or "api",
        ))
        db.commit()
        db.close()
    except Exception as e:
        log.warning(f"Local DB write failed (non-fatal): {e}")

    return {"success": True, "qualification": result}


@app.get("/leads", tags=["CRM - Leads"])
async def get_leads():
    ws = get_sheet("Homeowner Leads")
    if not ws:
        raise HTTPException(status_code=503, detail="Google Sheets not connected")
    rows = ws.get_all_records()
    return {"count": len(rows), "leads": rows}


@app.get("/leads/{lead_id}", tags=["CRM - Leads"])
async def get_lead(lead_id: int):
    ws = get_sheet("Homeowner Leads")
    if not ws:
        raise HTTPException(status_code=503, detail="Google Sheets not connected")
    rows = ws.get_all_records()
    match = next((r for r in rows if str(r.get("ID", "")) == str(lead_id)), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"Lead {lead_id} not found")
    return match


@app.get("/contractors", tags=["CRM - Contractors"])
async def get_contractors(availability: Optional[str] = None, trade: Optional[str] = None):
    ws = get_sheet("Contractors")
    if not ws:
        raise HTTPException(status_code=503, detail="Google Sheets not connected")
    rows = ws.get_all_records()
    if availability:
        rows = [r for r in rows if r.get("Availability", "").lower() == availability.lower()]
    if trade:
        rows = [r for r in rows if r.get("Trade", "").lower() == trade.lower()]
    return {"count": len(rows), "contractors": rows}


@app.post("/contractors", tags=["CRM - Contractors"])
async def add_contractor(contractor: ContractorInput):
    ws = get_sheet("Contractors")
    if not ws:
        raise HTTPException(status_code=503, detail="Google Sheets not connected")
    next_id = len(ws.col_values(1))
    ws.append_row([
        next_id, contractor.name, contractor.business_name or "",
        contractor.trade or "", contractor.phone or "", contractor.email or "",
        contractor.service_areas or "", contractor.rating or "",
        contractor.subscription_tier, contractor.availability, contractor.notes or "",
    ], value_input_option="USER_ENTERED")
    log.info(f"Contractor added: {contractor.name}")
    return {"success": True, "id": next_id, "name": contractor.name}


@app.get("/applications", tags=["CRM - Applications"])
async def get_applications(status: Optional[str] = None):
    ws = get_sheet("Contractor Applications")
    if not ws:
        raise HTTPException(status_code=503, detail="Google Sheets not connected")
    rows = ws.get_all_records()
    if status:
        rows = [r for r in rows if r.get("Status", "").lower() == status.lower()]
    return {"count": len(rows), "applications": rows}


@app.get("/matches", tags=["CRM - Matches"])
async def get_matches(status: Optional[str] = None):
    ws = get_sheet("Matches Pipeline")
    if not ws:
        raise HTTPException(status_code=503, detail="Google Sheets not connected")
    rows = ws.get_all_records()
    if status:
        rows = [r for r in rows if r.get("Status", "").lower() == status.lower()]
    return {"count": len(rows), "matches": rows}


@app.post("/matches", tags=["CRM - Matches"])
async def create_match(match: MatchInput):
    ws = get_sheet("Matches Pipeline")
    if not ws:
        raise HTTPException(status_code=503, detail="Google Sheets not connected")
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    row = [
        now, match.homeowner_name, match.homeowner_contact or "",
        match.contractor_name, match.contractor_contact or "",
        match.trade or "", match.match_type, "Pending",
        match.revenue_generated, match.notes or "",
    ]
    ws.append_row(row, value_input_option="USER_ENTERED")
    log.info(f"Match: {match.homeowner_name} -> {match.contractor_name}")
    return {"success": True, "match": row}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
