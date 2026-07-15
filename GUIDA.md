# Agentic-Factorio — Guida completa

Un compagno AI dentro il **tuo** mondo di Factorio. Gli scrivi in chat ("vai a minare
20 di ferro", "seguimi") e lui cammina, mina, piazza edifici e lavora al tuo fianco.

## 1. Cos'è e come funziona

Il companion è un personaggio in carne e ossa (beh, in pixel) che vive nella tua partita:
ha un corpo, un inventario vero, una portata limitata — niente magie, niente god mode.
Le mod di Factorio non possono accedere alla rete (per design), quindi serve un piccolo
programma esterno che fa da ponte: la mod dentro il gioco esegue le azioni e "percepisce"
il mondo, l'app companion parla con il modello AI via RCON, e il modello decide cosa fare
in base a quello che gli scrivi in chat.

```
   Tu (chat in gioco)
        │
        ▼
┌─────────────────────┐   RCON     ┌───────────────────┐   API / MCP   ┌──────────────┐
│      Factorio       │ ◀────────▶ │   App companion   │ ◀───────────▶ │     LLM      │
│  mod                │   (JSON)   │   (Node ≥ 22)     │               │  Claude /    │
│  "agentic-companion"│            │                   │               │  GPT / …     │
└─────────────────────┘            └───────────────────┘               └──────────────┘
```

## 2. Requisiti

| Cosa | Versione / nota |
| --- | --- |
| Factorio | 2.x (la mod richiede `base >= 2.0`) |
| Node.js | ≥ 22 |
| Un salvataggio dedicato | ⚠️ i comandi script **disabilitano gli achievement** su quel save — usa un save apposta se ci tieni |
| Un "cervello" | abbonamento Claude o ChatGPT, **oppure** una API key (OpenRouter consigliato), **oppure** Ollama gratis in locale |

## 3. Installazione

> **Nota sui comandi**: finché il pacchetto non è pubblicato su npm, i comandi
> `agentic-factorio …` si lanciano dal repo clonato:
>
> ```sh
> git clone <repo> && cd Agentic-Factorio && npm install && npm run build
> node companion/dist/cli.js <comando>     # setup | play | mcp | doctor
> ```
>
> Quando sarà su npm, l'equivalente sarà `npx agentic-factorio <comando>`.

### Installazione guidata (consigliata)

```sh
node companion/dist/cli.js setup
```

Il wizard fa tutto da solo, passo per passo:

1. **Trova Factorio** sul tuo computer (installazione e cartella dati utente).
2. **Configura RCON** in `config.ini` — fa prima un **backup** del file, poi aggiunge
   le due righe necessarie.
3. **Installa la mod** `agentic-companion` nella cartella mods e la abilita.
4. **Ti chiede quale "cervello"** vuoi usare (Claude Code, Codex, o API key) e ti
   stampa i comandi esatti per quello che hai scelto.

Dopo il setup **riavvia Factorio**: il file `config.ini` viene letto solo all'avvio.

### Installazione manuale (equivalente)

Se preferisci fare a mano, sono tre passi:

1. **RCON** — apri `config.ini` nella cartella dati utente di Factorio
   (macOS: `~/Library/Application Support/factorio/config/config.ini`,
   Windows: `%APPDATA%\Factorio\config\config.ini`, Linux: `~/.factorio/config/config.ini`)
   e aggiungi sotto la sezione `[other]`:

   ```ini
   local-rcon-socket=127.0.0.1:27015
   local-rcon-password=scegli-una-password
   ```

2. **Mod** — copia la cartella `mod/agentic-companion` del repo dentro la cartella
   `mods` di Factorio (oppure usa lo zip creato da `bash scripts/package-mod.sh`).

3. **Abilitala** — dal menu Mods in gioco, oppure aggiungi in `mods/mod-list.json`:

   ```json
   { "name": "agentic-companion", "enabled": true }
   ```

Checklist finale: ☐ due righe RCON in `config.ini` · ☐ mod nella cartella `mods` ·
☐ mod abilitata · ☐ Factorio riavviato.

## 4. Avvia la partita (importante!)

RCON funziona **solo su partite hostate**, non in single player classico. Quindi:

1. Avvia Factorio (riavviato dopo il setup, mi raccomando).
2. **Multiplayer → Host saved game** e scegli il tuo salvataggio.

Giocare "da solo ma hostato" va benissimo — non serve nessun altro giocatore.
Alla prima connessione Factorio avvisa che i comandi script disabilitano gli
achievement per quel save: è normale ed è il motivo del save dedicato.

## 5. I tre cervelli

Scegli **uno** di questi tre modi per dare un cervello al companion.

> Per i modi 1 e 2 serve il repo clonato e compilato una volta:
> `git clone … && cd Agentic-Factorio && npm install && npm run build`.

### 5a. Claude Code (abbonamento Claude)

Se hai Claude Code, registra il companion come server MCP:

```sh
claude mcp add factorio -- node <percorso-del-repo>/companion/dist/cli.js mcp
```

Poi apri una sessione di Claude Code e scrivi qualcosa tipo:

> **Tu:** collegati alla mia partita di Factorio e aiutami
>
> **Claude:** *(usa `connect_status` per verificare la connessione, poi `wait_for_chat`
> per ascoltare la chat di gioco)* Sono connesso! Ti aspetto in chat.
>
> **Tu (in chat di gioco):** vai a minare 20 di ferro
>
> **Claude:** *(usa `mine`, poi `say`)* — e in gioco vedi il companion camminare
> verso il giacimento e rispondere in chat: `[AI] Vado! 20 di ferro in arrivo.`

### 5b. Codex (abbonamento ChatGPT)

1. Fai login una volta: lancia `codex` e scegli **Sign in with ChatGPT**.
2. Registra il server MCP:

   ```sh
   codex mcp add factorio -- node <percorso-del-repo>/companion/dist/cli.js mcp
   ```

3. **Modalità consigliata — zero attese** (`--brain codex`): invece di tenere Codex in
   ascolto con `wait_for_chat`, lascia che sia la companion app ad ascoltare la chat
   (in locale, gratis) e a **svegliare Codex solo quando scrivi**:

   ```sh
   node companion/dist/cli.js play --brain codex
   ```

   Sotto il cofano ogni tuo messaggio in chat lancia `codex exec` (primo turno) /
   `codex exec resume` (turni successivi, stessa conversazione): niente polling,
   niente turni bruciati in attesa, reazione in ~1 secondo, e paga sempre il tuo
   abbonamento ChatGPT.

4. **Modalità interattiva** (alternativa): in una sessione `codex` scrivi *"collegati
   alla mia partita di Factorio e aiutami"* — l'assistente usa i tool (`connect_status`,
   `wait_for_chat`, `say`, `mine`, `place_entity`, …). In questa modalità Codex deve
   richiamare `wait_for_chat` in loop per ascoltare: per ridurre le chiamate imposta
   in `~/.codex/config.toml`, sotto `[mcp_servers.factorio]`:

   ```toml
   tool_timeout_sec = 900
   ```

   e digli di usare `wait_for_chat` con `timeout_s: 600` senza scrivere nulla tra
   una chiamata e l'altra. (Il timeout alto serve anche ai task lunghi, tipo
   "mina 50 di ferro".)

### 5c. API key (loop integrato)

Il companion gira da solo con il suo loop agentico:

```sh
export OPENROUTER_API_KEY=sk-or-...          # consigliato: una chiave, 300+ modelli
export AGENTIC_RCON_PASSWORD=la-tua-password # quella di config.ini (o usa il setup, che la salva)
node companion/dist/cli.js play
```

- In alternativa a OpenRouter: `ANTHROPIC_API_KEY` o `OPENAI_API_KEY`.
- `--model <id>` sceglie il modello (es. `--model anthropic/claude-sonnet-4.5`),
  `--provider openrouter|anthropic|openai|ollama` forza il provider quando hai
  più chiavi configurate.
- **Gratis in locale**: con Ollama non serve nessuna chiave e niente esce dal tuo
  computer — `--provider ollama --model <modello>` (es. `qwen3`), server su
  `http://localhost:11434` (personalizzabile con `OLLAMA_BASE_URL`).
- `--rcon-host`, `--rcon-port`, `--rcon-password` se non usi le variabili d'ambiente
  (default `127.0.0.1:27015`).

Quando parte vedrai in chat: `[AI] I'm online! Talk to me in chat…`. Da lì, scrivigli
in italiano: capisce benissimo.

## 6. Cosa sa fare

Scrivi in chat frasi normali — non servono comandi. Esempi che funzionano:

| Capacità | Scrivi in chat, per esempio |
| --- | --- |
| Guardarsi intorno | «cosa vedi intorno a te?» |
| Ispezionare macchine | «che problema ha il mio assemblatore?» |
| Camminare | «vieni qui» · «vai al giacimento di rame» |
| Seguirti | «seguimi» (continua finché non gli dici di smettere) |
| Minare ferro/alberi/rocce | «vai a minare 20 di ferro» · «taglia 10 alberi» |
| Piazzare edifici | «piazza una trivella a carbone sul ferro» |
| Costruire strutture complesse | «costruisci una farm di ferro automatica: trivelle sul giacimento con casse all'uscita» |
| Blueprint | «costruisci questa blueprint: 0eNq…» |
| Craftare | «crafta 10 ingranaggi di ferro» |
| Caricare macchine | «metti 10 carbone nel forno vicino a me» |
| Scaricare macchine | «svuota il forno e tieniti le piastre» |
| Cambiare ricette | «imposta l'assemblatore sul cavo di rame» |
| Ruotare | «ruota quel nastro verso sud» |
| Demolire (solo su tua richiesta esplicita) | «demolisci quel forno» |
| Diagnosticare la fabbrica | «che problemi ha la fabbrica?» (una chiamata: macchine ferme raggruppate, ingredienti mancanti, quadro elettrico) |
| Portarti le cose | «portami 50 piastre di ferro» (ti insegue anche se ti muovi) |
| Guidare | «prendi l'auto e vai al giacimento a ovest» (si rifornisce da solo) |
| Fare il guardiano | «difendi questa zona» (spara agli intrusi, ricarica le torrette, ripara i danni) |
| Fare il fuochista | «tieni riforniti i forni qui intorno» (pattuglia e ricarica il carbone) |
| Gestire i treni | «manda il treno 2 alla Stazione Ferro e fallo aspettare finché è pieno» |
| Squadra (fino a 4 companion) | «crea un companion di nome Anna» · «Anna mina il ferro mentre Bruno costruisce» — lavorano in parallelo, ognuno col suo colore ed etichetta |
| Reagire agli eventi | ti avvisa da solo se viene attaccato, muore, finisce una ricerca o una scorta — senza che tu chieda nulla |
| Combattere | «equipaggiati e ripulisci i nidi a nord» (si ritira da solo se ferito) |
| Avviare ricerche | «avvia la ricerca della logistica» |
| Respawn | «torna in vita» (se è morto) |

Per trovarlo in gioco: ha un'etichetta **AI** fluttuante sopra la testa, un marker
**AI** sulla mappa/minimappa che lo segue, e se gli chiedi «dove sei?» risponde con un
ping cliccabile che apre la mappa sulla sua posizione.

Non devi dirgli di avvicinarsi prima: ogni azione su una posizione **cammina da sola
fino a portata** usando il pathfinder del gioco. E una garanzia di sicurezza: il
companion può demolire i tuoi edifici, ma **solo se glielo chiedi esplicitamente**
(«demolisci quel forno») — mai di sua iniziativa. Il mining resta limitato a risorse,
alberi e rocce: per gli edifici l'unico canale è la demolizione su richiesta, che
recupera tutto nel suo inventario.

## 6-bis. Come ragiona quando costruisce

Non ha layout precotti: progetta. Ha una mappa ASCII della zona (`scan_area`), le
geometrie esatte delle macchine — ingombro in tile, dove depositano gli oggetti
(`describe_prototype`) — un dry-run che verifica un piazzamento senza toccare nulla
(`can_place`) e un piano batch che esegue decine di piazzamenti in sequenza
(`build_plan`). Quindi puoi chiedergli **qualsiasi** costruzione e le coordinate le
calcola lui; più la richiesta è specifica, meglio esegue.

## 7. Comandi speciali

| Comando | Cosa fa |
| --- | --- |
| `!stop` (in chat) | **Kill switch**: cancella all'istante tutto quello che sta facendo e la coda dei task |
| `--proactive N` (flag di `play`) | Report periodici: ogni **N minuti** il companion guarda la fabbrica e parla in chat solo se c'è qualcosa che merita attenzione |
| `--fresh` (flag di `play`) | Riparte con la memoria vuota (ignora la sessione salvata) |
| `--brain codex` (flag di `play`) | Cervello = il tuo abbonamento ChatGPT via `codex exec`: la app ascolta la chat e sveglia Codex solo quando scrivi — niente polling |

I "turni di servizio" (`seguimi`, `difendi la zona`, `tieni riforniti i forni`) durano
finché non dici `!stop` o gli dai un altro compito. Con più companion, `!stop` ferma
TUTTI; per fermarne uno solo: «Anna, fermati».

## 8. Risoluzione problemi

Primo passo sempre: `node companion/dist/cli.js doctor` controlla configurazione, mod e connessione, e per ogni problema stampa il fix.

| Sintomo | Causa probabile | Fix |
| --- | --- | --- |
| Il companion non risponde in chat | La partita non è hostata (single player classico) | Esci e rientra da **Multiplayer → Host saved game** |
| `RCON connection refused` | RCON non configurato, Factorio non riavviato dopo il setup, o porta/password sbagliate | Controlla le due righe sotto `[other]` in `config.ini`, riavvia Factorio, verifica che `AGENTIC_RCON_PASSWORD` corrisponda |
| La mod non compare nella lista Mods | Cartella copiata nel posto sbagliato o non abilitata | La cartella (o lo zip) va dentro `mods/`; abilitala dal menu Mods o in `mod-list.json` |
| Risposta vuota / "empty response" al primo comando | Factorio "ingoia" il primo comando Lua della sessione (avviso achievement) | Comportamento noto: il companion lo gestisce da solo ripetendo il comando alla connessione; se persiste, riconnetti |
| Avviso "achievements disabled" | Normale: qualsiasi comando script disabilita gli achievement su quel save | Usa un salvataggio dedicato al companion |
| Il personaggio è morto | Un morso di troppo | Scrivigli «torna in vita»: rinasce vicino a te (o allo spawn) |

## 9. Limiti attuali e roadmap

Oggi il companion **non**:

- guida veicoli o treni, e non gestisce le reti di circuiti;
- si moltiplica: **un solo companion** per partita.

E in combattimento è un fante con la pistola, non un esercito: ripulisce i nidi
vicini ma niente gestione torrette. Sono le prossime voci della roadmap, insieme a
miglioramenti continui a percezione e task.

## 10. Privacy e costi

**Cosa viene inviato al modello AI:** solo snapshot dello stato di gioco (posizioni,
inventari, macchine e risorse vicine, ricerca in corso, produzione) e i messaggi della
chat di gioco. Nient'altro: niente file del tuo computer, niente dati personali.

**Costi:**

| Cervello | Costo |
| --- | --- |
| Claude Code / Codex via MCP | Incluso nel tuo abbonamento Claude / ChatGPT, nessun costo extra |
| API key (OpenRouter, Anthropic, OpenAI) | Paghi a consumo per token; su OpenRouter puoi scegliere modelli molto economici |
| Ollama in locale | Gratis — e i dati di gioco non lasciano il tuo computer |

Buon divertimento in fabbrica. The factory must grow — ora in due. 🏭
