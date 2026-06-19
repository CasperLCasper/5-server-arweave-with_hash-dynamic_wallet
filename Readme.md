# 🌐 NFT Multichain Wallet Visualizer

Šis projekts ir veiksmīgi pārnests no Vercel uz **Cloudflare Pages** un pilnībā pielāgots modernajai **Vite** moduļu sistēmai zibensātrai darbībai.

Dynamic Wallet Visualizer ir Web3 priekšgala (frontend) aplikācija, kas pārvērš lietotāja kriptovalūtu maciņa datus (ETH bilanci, žetonu skaitu un transakciju vēsturi) unikālā, interaktīvā un dzīvā mākslas vizualizācijā. Aplikācija piedāvā iespēju šo vizualizāciju ierakstīt HD video formātā un nomintot kā dinamisku NFT **Base Sepolia** testa tīklā.

---

## ☁️ Cloudflare Pages Būvēšanas Iestatījumi

Pārliecinieties, ka jūsu Cloudflare Pages projekta būvēšanas iestatījumi (Build settings) ir konfigurēti precīzi šādi, lai Vite varētu pareizi optimizēt moduļus:

* **Framework preset:** `None`
* **Build command:** `npm run build`
* **Build output directory:** `dist`
* **Root directory:** `/` (projekta sakne)

Katru reizi, kad veiksiet izmaiņas šeit, GitHub, Cloudflare fonā automātiski pārbūvēs un atjauninās dzīvo mājaslapu.

---
Environment Variables:

ALCHEMY_API_KEY

ALCHEMY_RPC_URL

CONTRACT_ADDRESS
	
JWT_SECRET
	
PINATA_GATEWAY
	
PINATA_JWT
	
SERVER_PRIVATE_KEY

UPSTASH_REDIS_REST_URL

UPSTASH_REDIS_REST_TOKEN


## ⚙️ Atkarību Atjaunināšana (GitHub Actions)

Tā kā projekta izstrāde un labojumi tiek veikti pa tiešo GitHub vidē (bez lokālas vides uzstādīšanas), repozitorijā ir nepieciešams izveidot automatizētu rīku atkarību un slēdzeņu faila (`package-lock.json`) sakārtošanai.

### 1. Workflow faila izveide
Izveidojiet failu ceļā `.github/workflows/update-lock.yml` ar šādu saturu:
name: Update package-lock.json

on:
  workflow_dispatch:   # Ļauj jebkurā brīdī palaist manuāli ar pogu
  schedule:
    - cron: '0 0 * * 1'  # Automātiski palaidīsies katru pirmdienas rītu (00:00 UTC)

permissions:
  contents: write

jobs:
  update-lock:
    runs-on: ubuntu-latest
    steps:
      # Izmantojam jaunāko checkout versiju
      - uses: actions/checkout@v5
      
      # Nodrošinām Node.js vidi
      - uses: actions/setup-node@v5
        with:
          node-version: '22'
          
      # 🚀 LABOJUMS 1: Pilnībā nodzēšam lock failu un uzbūvējam no jauna ar install
      - name: Force rebuild package-lock
        run: |
          rm -f package-lock.json
          npm install

      # 🔍 ŠIS SOLIS PARĀDĪS VAINĪGO:
      # Pārbaudām, kuras pakotnes pieprasa turbo-sdk un kura versija tiek ielikta
      - name: Find out who blocks turbo-sdk
        run: |
          npm ls @ardrive/turbo-sdk || echo "Parādām konfliktu koku..."

      # Šī rindiņa piespiež nodzēst papildus ievainojamības, ja tādas palikušas
      - name: Run npm audit fix
        run: npm audit fix --force || echo "Salabots viss, ko varēja"
      
      # 🚀 LABOJUMS 2: Sakārtots Commit & Push ar [skip ci]
      - name: Commit & Push updated package-lock.json
        run: |
          git add package-lock.json
          
          # Pārbaudām staged izmaiņas
          if git diff --cached --exit-code package-lock.json; then
            echo "Nav jaunu versiju, package-lock.json nav mainījies."
          else
            echo "Atrasti atjauninājumi! Veicam saglabāšanu..."
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            
            # Pievienojam [skip ci], lai Action neieietu bezgalīgā cilpā
            git commit -m "chore: auto-update package-lock.json [skip ci]"
            
            # Drošs push uz pašreizējo aktīvo zaru
            git push origin HEAD:${{ github.ref_name }}
          fi
