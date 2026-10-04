# OpenDots: inventario e cosa prenderne

Analisi del 2026-10-04 del repository pubblico [CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots) (MIT, alpha, versione 0.1.0), letto in sola lettura dalla copia locale (D-059). Serve a scegliere, una proposta alla volta, cosa portare in Arianna. Le proposte accettate diventano voci in `DECISIONS.md` e task della fase giusta; questo file tiene l'elenco e lo stato.

## In breve

OpenDots è un template per "agenti personali con il proprio computer": agenti specializzati (Dots), pagine stile Notion (Spaces), chat, chiamate vocali dal browser, Slack, un container per agente con browser, file e shell. Stack: Node 24, Hono, React 19, CopilotKit runtime e react-core 1.75, AG-UI, TanStack AI, Tiptap 3, `node:sqlite`.

**Il limite per noi:** chat, storico, task programmati, voce e Slack passano tutti da **CopilotKit Intelligence** (servizio cloud con `INTELLIGENCE_API_KEY`), e i modelli da un endpoint compatibile OpenAI; la voce usa OpenAI Realtime. Nulla di questo rispetta la regola L2/L3. Si prendono **interfaccia, schemi e logica pura**, mai il collegamento a quei servizi.

**Licenza:** MIT (anche OpenBot, `deployment/computers/LICENSE.openbot`). Copiare codice o CSS richiede di conservare l'avviso di copyright: un file che deriva da OpenDots porta in testa un commento con origine e licenza, e il testo della licenza va in `third_party/opendots/LICENSE` alla prima copia.

## Inventario delle funzionalità

Legenda della colonna "Per Arianna": **Prendere** (codice, CSS o schema riusabile), **Idea** (riscrivere sul nostro stack), **No** (incompatibile). La fase è quella di `ROADMAP.md`.

### Interfaccia e grafica

| Funzionalità | Dove | Cloud | Per Arianna |
| --- | --- | --- | --- |
| Shell a tre colonne: barra icone 48px, sidebar 220px (Dots, Spaces, chat recenti, Attività, Memorie, Impostazioni), area di lavoro con topbar 64px (breadcrumb, Pausa, computer) | `App.tsx`, `style.css:3065-3300` | No | **Prendere**, 1A (P1) |
| Linguaggio visivo: neutri caldi (`#f5f5f5`, `#f9f9f9`, `#fafafa`), accento teal (`#3d7e75`), font di sistema 14px, titoli 550 con `letter-spacing -0.04em`, raggi 9/12–16/22px, ombre leggerissime, focus `#b8c4fa` | `style.css`, `editor.css` | No | **Prendere** come token Tailwind, 1A (P1). Non c'è tema scuro: da fare noi |
| Chat: bolla utente teal a destra (raggi `17 17 5 17`), assistente senza bolla, intestazione con avatar e stato ("Thinking…", "Here with you", "Paused"), tre pallini animati, Invio per inviare, Stop durante l'esecuzione | `Chat.tsx`, `ChatTranscript.tsx`, `style.css:2177-2223` | No | **Prendere**, 1A (P1) |
| Mascotte: 4 peluche 3D in PNG 512×512 (blu, menta, arancio, viola), colore scelto per hash dell'id, stati CSS `working` (oscillazione), `paused` (desaturato), `needs-input`, `complete` | `Mascot.tsx`, `public/dots/*.png` | No | **Prendere** per Arianna e Coder, 1A (P2); base anche per l'ufficio pixel (3) |
| Schede degli strumenti in chat: icona, azione ("Opening website"), stato (Working / Finished / Needs attention / Interrupted), dettaglio, output, anteprima live | `ComputerToolCard.tsx`, `style.css:3600-3705` | No | **Idea**: per i passi dell'orchestratore e le deleghe al Coder, 1A (P3) |
| Scheda di revisione con anteprima markdown e "Approva e salva" / "Rifiuta" | `PageReviewCard.tsx` | No | **Idea**: restyling della nostra `ApprovalCard`, 1A (P3) |
| Pannello risultati a destra (Brief, computer), che sotto 1100px diventa un pannello sovrapposto | `ResultPane.tsx` | No | **Idea**, 1A/3 |
| Modale unica con focus trap ed Esc, righe di permessi con checkbox | `WorkspaceDialog.tsx` | No | **Idea** per Impostazioni (3.5) |
| Responsive: sidebar a scomparsa sotto 700px, sette breakpoint, `prefers-reduced-motion` rispettato | `style.css:3437-3489` | No | **Prendere** con P1 |
| Icone lucide (nessuna disegnata a mano) | tutto il client | No | **Prendere**: `lucide-vue-next`, con voce D- (P1) |

### Chat e conversazioni

| Funzionalità | Dove | Cloud | Per Arianna |
| --- | --- | --- | --- |
| Thread con titolo generato, lista con "Carica altri" | `ThreadList.tsx`, Intelligence | **Sì** | Già nostro (D-057); paginazione: **Idea** |
| Streaming, Stop, ripresa dello storico | `useAgent` di CopilotKit | **Sì** | Già nostro (WebSocket); Stop: **Idea** se manca |
| Un thread per ogni coppia pagina×agente, con contesto della pagina marcato "untrusted" | `pages.ts:211-236`, `page-context.ts` | **Sì** (storico) | **Idea**, 2 (KB) |
| Campo facoltativo "URL di partenza" nel composer | `Chat.tsx:376-416` | No | **Idea**, piccola |
| "Salva la conversazione come pagina" (storico → Markdown) | `page-service.ts:97-146` | Sì (storico) | **Idea**, 2: conversazione → pagina KB, con l'etichetta della conversazione |
| Run interrotto se cambiano pausa o permessi a metà (controllo ogni 100ms) | `dot-agent.ts:85-110` | No | **Idea**: pausa globale e revoca sui nostri eventi (P5) |
| Messaggi `system` del client scartati; contenuti esterni marcati "untrusted" nel prompt | `dot-agent.ts:267, 283-286` | No | Già simile; da verificare (P5) |

### Pagine (Spaces) e file

| Funzionalità | Dove | Cloud | Per Arianna |
| --- | --- | --- | --- |
| Pagine Markdown gerarchiche, controllo anti-ciclo, revisione ottimistica (409 sul conflitto) | `pages.ts` | No | **Idea**, 2 (KB) su PostgreSQL |
| Editor Tiptap: titoli, liste, checklist, citazioni, codice, tabelle, link solo http(s)/interni, incolla senza img/iframe/script | `RichEditor.tsx`, `editor/markdown.ts` | No | **Prendere**: `slash-commands.ts` e `markdown.ts` dipendono solo da `@tiptap/core`, 2 (P6) |
| Comandi `/` accessibili da tastiera | `editor/slash-commands.ts` | No | **Prendere**, 2 (P6) |
| Markdown sicuro: si passa alla modalità sorgente se il giro andata e ritorno non è identico (front-matter, HTML, formule) | `editor/markdown.ts:40-94` | No | **Prendere**, 2: protegge le note di Obsidian e della KB |
| Salvataggio automatico (800ms), stati salvato/modificato/salvataggio/errore/conflitto, bozza preservata, ⌘S, avviso in uscita | `editor/autosave.ts` | No | **Prendere** (logica pura), 2 (P6) |
| Libreria: ricerca, ordinamento, griglia/lista, card con estratto | `SpaceLibrary.tsx` | No | **Prendere** (UI), 2 |
| Indice della pagina, albero delle sottopagine, "Sposta pagina" | `PageOutline.tsx`, `SpaceNav.tsx` | No | **Idea**, 2 |
| Chat accanto alla pagina (pannello laterale 360px) | `PageConversation.tsx` | Sì (storico) | **Idea**, 2 |
| Strumenti dell'agente sulle pagine (`list/read/create/edit_space_page`) con accesso per Space | `page-tools.ts` | No | **Idea**, 2. Da noi la scrittura passa da approvazione, non solo se chiesta nel prompt |
| Esporta la pagina in `.md` | `PageDocument.tsx:89-98` | No | **Idea** |
| Upload di file, versioni delle pagine, cancellazione | — | — | **Assenti** in OpenDots: da progettare noi |

### Agenti, memoria, ricerca, task

| Funzionalità | Dove | Cloud | Per Arianna |
| --- | --- | --- | --- |
| Agenti specializzati: nome, istruzioni, permessi (ricerca, memoria), Space autorizzati | `workspace-routes.ts:10-21` | No | Già nostro (schede YAML, D-034) |
| Memorie inserite a mano e iniettate nel prompt se abilitate | `app.ts:187-217` | Solo LLM | Già previsto più ricco (KB, 2) |
| Skill apprese ("Learning") | `learning.ts` | **Sì** | **No** |
| Ricerca web via Parallel (MCP cloud) | `parallel.ts` | **Sì** | **No** (solo L0, eventualmente, con voce D-) |
| Lettore di pagine pubbliche: Playwright senza JS, DNS fissato su IP pubblico, IP privati e redirect bloccati, 5MB, 50 richieste | `src/browser/*` | No | **Idea** forte per il futuro agente web (P7) |
| Task programmati con lease e intervallo | `store.ts`, `runner.ts` | Sì (turni) | Già previsto (scheduler, 2) |

### Chiamate vocali

| Funzionalità | Dove | Cloud | Per Arianna |
| --- | --- | --- | --- |
| Schermata di chiamata: gradiente teal, mascotte che "respira" mentre parla, timer, didascalie live, pulsanti Altoparlante/Chiudi/Muto, versione ridotta in basso a destra | `CallView.tsx`, `style.css:3792+` | No | **Prendere**, 4 (P4: anche subito come guscio) |
| WebRTC browser↔OpenAI Realtime, con offerta SDP inoltrata dal server (la chiave non arriva al browser) | `voice.ts:32-157`, `useVoice.ts` | **Sì** | **No** così com'è; il contratto sì |
| Un solo strumento in voce, `ask_compute`: la voce delega all'agente testuale sullo **stesso thread** | `voice.ts:90-103, 178-187` | Sì | **Idea** chiave per la fase 4 |
| Sessioni limitate: 15 minuti, 6 deleghe da 90s, 30s per connettersi, una chiamata alla volta, chiusura se si mette in pausa | `voice.ts` | No | **Idea**, 4 |
| Ricevuta nella chat a fine chiamata: trascrizione salvata, riassunto delle sole decisioni confermate, ancorata al messaggio | `voice.ts:212-241`, `voice-receipt.ts` | Sì (turno) | **Idea**, 4 |
| Riaggancio robusto (silenzia, conferma dal server, `keepalive`, controllo ogni 2s) | `useVoice.ts:49-123` | No | **Prendere** (logica), 4 |
| Telefono vero (SIP, Twilio) | — | — | **Assente** |

**Per renderla locale** si tiene il contratto (`begin(sdp)`, `activate`, `compute`, `end` e gli eventi del DataChannel con gli stessi nomi) e si sostituisce OpenAI con: server WebRTC nostro (in `apps/voice`, Python: aiortc o pipecat), VAD Silero con interruzione, STT whisper in streaming, TTS locale (Kokoro o Piper). Così `useVoice` e `CallView` restano quasi uguali.

### Slack (per noi: Telegram)

| Funzionalità | Dove | Cloud | Per Arianna |
| --- | --- | --- | --- |
| Adattatore Slack gestito da Intelligence (niente webhook propri) | `slack-channel.ts`, `platform.ts` | **Sì** | **No** |
| Allowlist doppia (team + utente umano) controllata in `identifyUser` e di nuovo negli handler; scartati messaggi di bot, modifiche, cancellazioni | `slack-channel.ts:31-61` | No | **Idea** per Telegram, 1B |
| Esecuzione in serie per thread; thread seguito solo dopo una menzione | `slack-channel.ts:110-161` | No | **Idea**, 1B |
| Thread esterno collegato a una conversazione locale visibile anche nel web | `dot-agent.ts:63-73` | Sì | Già nostro (conversazione di Telegram) |
| Errori generici verso il canale (`safeFailure`), avviso se in pausa | `slack-channel.ts:12-28, 75-80` | No | **Idea**, 1B |
| Approvazioni dal canale | — | — | **Assenti**; da noi pulsanti inline di Telegram (1B) |

### Computer per agente

| Funzionalità | Dove | Cloud | Per Arianna |
| --- | --- | --- | --- |
| Container Docker per agente con volumi persistenti; solo il supervisor ha il socket Docker; gVisor facoltativo | `compose.computers*.yml`, `docs/COMPUTERS.md` | No | **Idea** per confinare gli esecutori (P8) |
| Credenziale HMAC per agente, verifica dell'identità del container, risposte limitate e ripulite dai segreti | `computer-service.ts:41-176` | No | **Idea** |
| Permessi browser/file/shell per agente, spenti all'inizio, ricontrollati ogni 50ms, revoca che interrompe | `computer-store.ts`, `computer-service.ts:336-342` | No | **Idea** (P5, P8) |
| Pannello computer: schede Browser (screenshot cliccabile ogni 4s), File, Terminale, Attività | `ComputerPanel.tsx` | No | **Idea**, 3 (HUD) |
| Presa di controllo manuale del browser, e l'agente rilegge la pagina prima di ripartire | `computer-service.ts:260-311` | No | **Idea**, futuro agente web |
| Registro azioni senza valori digitati, contenuti né comandi, ultime 1000 per agente | `computer-store.ts:27-50` | No | **Idea**, coerente con "niente dati privati nei log" |

### Sicurezza del server

Bind su loopback; token obbligatorio fuori da loopback, confrontato con `timingSafeEqual`; allowlist degli host contro il DNS rebinding; Origin esatto e `Sec-Fetch-Site` contro il CSRF; CSP stretta; zod `.strict()` sui body; proxy che accetta solo route in whitelist. **Idea** per il task 1.13 (autenticazione): confrontare punto per punto con il nostro core.

## Proposte, in ordine

Una alla volta; ognuna si propone con il dettaglio, l'utente sceglie, poi diventa voce D- e task.

| # | Proposta | Fase | Stato |
| --- | --- | --- | --- |
| P1 | Restyling della chat web: struttura e cura di OpenDots (shell a tre colonne, bolle, intestazione con stato, composer, responsive, icone `lucide-vue-next`) **fusa** con una HUD stile Jarvis, in un'unica identità e non come due temi (scelta dell'utente, 2026-10-04) | 1A | **Costruita** (2026-10-04) in `apps/hud`: colonna di icone, barra laterale con agenti e conversazioni per giorno, intestazione con l'anello, schede HUD per passi, rapporti del Coder e approvazioni dentro la chat, pannello di stato con dati veri (`GET /api/status`: agenti, ultima decisione del router, gateway di oggi, solo conteggi ed etichette), tema scuro o chiaro dal sistema o scelto (D-061 icone, D-062 font). Da guardare insieme all'utente |
| P2 | **Pixel agent al posto delle mascotte** (l'utente non vuole i peluche): personaggi pixel-art con stati (pensa, lavora, aspetta te, in pausa), gli stessi dell'ufficio pixel di fase 3; l'utente vuole poter usare anche personaggi di film, telefilm e cartoni: pacchetti di personaggi caricati da `data/` (fuori da git), mentre il repository contiene solo personaggi originali | 1A | **Costruita** (2026-10-04): Arianna e Coder originali in `apps/hud/characters/originali` (112×128, generati da `node apps/hud/characters/build.ts`), pacchetti di `data/characters` letti e controllati dal core (`GET /api/characters`), `[characters]` in `arianna.toml` applicata senza riavvio |
| P3 | Schede in chat per passi dell'orchestratore, deleghe al Coder e approvazioni, nello stile delle loro schede strumento | 1A | Da proporre |
| P4 | Schermata di chiamata con il contratto `begin/activate/compute/end` e la ricevuta in chat | anticipata | **Scelta dall'utente (2026-10-04): chiamata vera subito**, non un guscio: icona del telefono in chat, voce tutta locale (`apps/voice`: trascrizione, sintesi, audio in tempo reale), con una voce D- prima del codice. Prossimo task dopo il logo |
| P10 | **Computer dell'agente** (icona dello schermo di OpenDots, `ComputerPanel.tsx`): browser, file, terminale e attività dell'agente | dopo P4 | **Scelto dall'utente (2026-10-04): dopo le chiamate, "ampliamo il più possibile questa parte"**. Dentro: file modificati e chi ha fatto cosa (richieste del 2026-10-03), righe di attività salvate, poi browser e terminale dal vivo con il confinamento in container (P8) |
| P5 | Pausa globale e revoca dei permessi che interrompono i run in corso | 1A/1B | Da proporre |
| P6 | Editor delle pagine KB: Tiptap con comandi `/`, Markdown sicuro, salvataggio automatico con conflitti | 2 | Da proporre |
| P7 | Lettore di pagine pubbliche isolato (Playwright senza JS, anti-SSRF) per il materiale L0 | 2/5 | Da proporre |
| P8 | Container per esecutore e agente web, sul modello del supervisor OpenBot | dopo 1.6 | Da proporre |
| P9 | Schemi di Telegram ripresi da Slack: allowlist doppia, serie per thread, errori generici, avviso di pausa | 1B | Da proporre |

## P2 in dettaglio: pacchetti di personaggi (accettata, 2026-10-04, D-060)

**Formato degli sprite di pixel-agents** (letto dal codice, MIT, copia locale in sola lettura con D-059): un personaggio è un PNG di **112×96 pixel**, cioè fotogrammi di **16×32** in 7 colonne e 3 righe (`core/src/assets/constants.ts`). Le righe sono le direzioni **giù, su, destra**; la sinistra si ottiene specchiando la destra. Le colonne: **0–2 camminata** (sequenza 0-1-2-1), **3–4 scrittura**, **5–6 lettura** (`webview-ui/src/office/sprites/spriteData.ts:133-151`). I fumetti "permesso" e "in attesa" li disegna il motore, non il personaggio (`office/types.ts:204`). pixel-agents carica i file `char_N.png` anche da una cartella esterna (Impostazioni → Add Asset Directory). I 6 personaggi inclusi derivano da JIK-A-4 Metro City, la cui licenza non è chiara (`OPEN-QUESTIONS.md`): non li usiamo come base.

**Proposta per Arianna:**

1. **Un personaggio = un foglio nel formato di pixel-agents**, identico byte per byte. Così lo stesso file funziona nella chat, nel pannello degli agenti e nell'ufficio della fase 3 (basta indicare a pixel-agents la stessa cartella).
2. **Stati di Arianna ricavati da quei fotogrammi**, senza chiedere disegni in più:

   | Stato | Fotogrammi | Aggiunta |
   | --- | --- | --- |
   | Inattivo | giù, colonna 1 (in piedi, di fronte) | leggera oscillazione |
   | Pensa | giù, colonne 5–6 (lettura) | fumetto "…" |
   | Lavora | giù, colonne 3–4 (scrittura) | fumetto con la tastiera |
   | Aspetta te | giù, colonna 1 | fumetto "!" ambra, come il "permesso" di pixel-agents |
   | In pausa | giù, colonna 1 | grigio e "zz" |

   Facoltativo: una quarta riga (112×128) con fotogrammi dedicati a pensa, aspetta, pausa; se c'è la usiamo, pixel-agents la ignora. **Quarta riga dei personaggi originali** (rivolta in basso): colonne 0–1 pensa, 2–3 aspetta te (mano alzata), 4–5 pausa (occhi chiusi), 6 battito di ciglia.
3. **Pacchetto = cartella in `data/characters/<pacchetto>/`**, fuori da git: i fogli PNG più un `pack.json` con nome del pacchetto, fonte (testo libero, per ricordarsi da dove viene) e per ogni personaggio `id`, nome mostrato e file. Il core lo serve in sola lettura alla chat web. **Scelta dell'utente: per ora il pacchetto si copia a mano nella cartella** e Arianna lo trova da sola; il caricamento dalla chat web arriva, se serve, con la pagina Impostazioni (3.5) dopo l'autenticazione. Alla lettura il core controlla dimensioni esatte (112×96 o 112×128), solo PNG e JSON, peso massimo.
4. **Quale personaggio ha ogni agente** è un'impostazione dell'utente (in `arianna.toml` finché non c'è la pagina Impostazioni 3.5), non una proprietà della scheda agente.
5. **Personaggi originali nel repository:** Arianna (col filo rosso) e Coder (robot con visiera) ridisegnati nel formato 16×32 con tutte e 21 le pose, licenza del progetto. Sono anche il ripiego quando un pacchetto manca o non è valido.
6. **Diritti:** i personaggi di film, telefilm e cartoni l'utente li mette in `data/characters` per uso personale; non entrano mai in git né nei backup condivisi, e Claude non li disegna né li scarica.
