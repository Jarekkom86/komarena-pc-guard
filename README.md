# Komarena.sk PC Guard

Lokalny Windows dashboard pre PC agenta zameraneho na bezpecnost, vykon, hardware, software, pripojene zariadenia a dlhodoby backlog uloh. Verejny repozitar obsahuje iba prenositelne zdrojove subory; lokalne konfiguracie, prevadzkove data a prihlasovacie udaje su zamerne vylucene.

## Technicky profil

- Node.js server bez externych runtime zavislosti,
- lokalne webove UI,
- PowerShell audit s read-only zberom telemetrie,
- API viazane predvolene iba na `127.0.0.1`,
- explicitne bezpecnostne hranice pre buduce opravne akcie.

## Spustenie

```powershell
.\start.ps1
```

Potom otvor:

```text
http://127.0.0.1:3000
```

## Lokalne API

- `GET /api/health` - stav hlavneho lokalneho servera.
- `GET /api/pc/status` - rychly read-only PC stav.
- `GET /api/pc/scan?mode=quick` - standardny scan.
- `GET /api/pc/scan?mode=deep` - hlbsi scan so zoznamom aplikacii.
- `GET /api/pc/tasks` - produktovy backlog.
- `POST /api/pc/tasks` - nova backlog uloha.
- `PATCH /api/pc/tasks/:id` - zmena stavu ulohy.
- `GET /api/integrations` - inventar najdenych agentov.

## Bezpecnostne hranice

Audit modul `scripts/komarena-pc-audit.ps1` je read-only. Zbiera vykon, RAM, disky, dostupne teplotne senzory, Defender, firewall, startup polozky, pripojene zariadenia a heuristicke signaly procesov.

Nie je to este plna nahrada antiviru. Prva verzia pouziva Microsoft Defender telemetry a vlastne heuristiky. Karantena, podpisovy scan, hash reputacia, opravy a zatazove hardware testy patria do dalsich backlog uloh a maju byt spustane az po explicitnom potvrdeni.

Server je predvolene viazany na `127.0.0.1`, aby dashboard nebol vystaveny celej lokalnej sieti.
