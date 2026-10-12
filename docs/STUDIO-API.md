# API dello Studio di design (I-19, D-184)

Contratto fra il core (`apps/core`), il pacchetto `@arianna/pptx` e la pagina «Studio» della chat web (`apps/hud`). Le rotte stanno sotto `/api/studio/`, solo loopback e stessa origine come le altre rotte del core. Nomi dei campi JSON in camelCase. Nessun testo dei mockup esce dalla macchina per queste rotte: lo Studio li mostra e li modifica in locale; il Designer li scrive con i suoi run (D-159), che passano dal gateway come sempre.

Errori: `{ "error": "<codice>" }` con lo stato HTTP: 400 `invalid` (richiesta sbagliata), 403 `refused` (percorso fuori dalla cartella dei mockup, file nascosto, collegamento simbolico, segreto, valore del vault nel testo), 404 `not-found` (progetto non registrato o non approvato, file che non c'è), 409 `changed` (il file è cambiato dall'ultima lettura: la risposta porta anche `sha256` attuale), 413 `too-large`.

## Progetto e cartella

`:project` è il nome di un progetto di Impostazioni → Progetti (`[[project]] name`), con la stessa regola di `approvedRoot` delle deleghe (`apps/core/src/delegation-view.ts`): un progetto non registrato o non approvato è 404. La cartella dei mockup è quella del prompt del Designer (`agents/designer.md`): `docs/mockups/` se il progetto è il repository di Arianna (ha `docs/DECISIONS.md` e `apps/hud/`), altrimenti `mockups/`. Le rotte leggono e scrivono **solo** file `.html` direttamente dentro quella cartella (niente sottocartelle), con i controlli di `readProjectBytesAt` (niente file nascosti, niente collegamenti simbolici che escono, niente `.git`) e di `readOpenBytes` (niente percorsi da segreto, niente valori del vault). Dimensione massima di un mockup: 2 MiB.

## Mockup

- `GET /api/studio/:project/mockups` → `{ folder, files: Mockup[] }`; `folder` è `mockups` o `docs/mockups`; cartella mancante: `files: []`. Ordine: per `group`, poi per `variant` crescente.
- `GET /api/studio/:project/file?path=<folder>/<nome>.html` → `{ path, text, sha256 }`.
- `PUT /api/studio/:project/file` `{ path, text, base }` → `{ path, sha256 }`. Modifica diretta dallo Studio (D-184, O6): riscrive un mockup **che esiste già**, solo se il suo sha256 è ancora `base` (altrimenti 409 `changed` con lo `sha256` attuale). Il testo nuovo passa lo stesso controllo dei valori del vault (403 se ne contiene uno). Scrittura atomica (file temporaneo nella stessa cartella e `rename`). Il core scrive un evento `studio.edit` con progetto, percorso, sha256 vecchio e nuovo e dimensione: mai il testo.

`Mockup = { path, name, group, variant, bytes, modified, sha256 }`: `name` è il nome del file; `group` il nome senza il numero finale e l'estensione (`landing-2.html` → `landing`), `variant` quel numero (`null` senza numero); `modified` ISO 8601.

## Esportazione PPTX

- `POST /api/studio/:project/pptx` `{ path, deck }` → il file `.pptx` (`content-type: application/vnd.openxmlformats-officedocument.presentationml.presentation`, `content-disposition: attachment; filename="<nome del mockup>.pptx"`). `path` è il mockup da cui viene il deck (deve esistere, stessi controlli della lettura): serve al nome del file e all'evento `studio.export` (progetto, percorso, numero di slide). Niente viene scritto nel progetto.

`deck` è un `Deck` di `@arianna/pptx`, che la pagina ricava dal mockup con `DOMParser` (lo Studio non esegue gli script del mockup per farlo). Il core lo controlla con `parseDeck` (400 `invalid` se non va) e lo scrive con `writePptx`.

```ts
type Deck = { title: string; slides: Slide[] };            // 1-200 slide; title 1-200 caratteri
type Slide = {
  title?: string;        // al più 300 caratteri
  subtitle?: string;     // al più 300
  paragraphs?: string[]; // al più 30, ciascuno al più 2000
  bullets?: string[];    // al più 30, ciascuno al più 500
  notes?: string;        // note del relatore, al più 5000
  background?: string;   // #rrggbb
  color?: string;        // #rrggbb, colore del testo
  accent?: string;       // #rrggbb, colore del titolo
  titleFont?: string;    // nome di un carattere (lettere, cifre, spazi, . ' -; al più 64)
  bodyFont?: string;     // carattere di sottotitolo, paragrafi e punti elenco
  titleSize?: number;    // punti interi, 8-120
  bodySize?: number;     // punti interi, 8-120; il sottotitolo è 1,2 volte il testo
};
```

Diapositive 16:9 (12 192 000 × 6 858 000 EMU); titolo in alto, sottotitolo sotto, poi paragrafi e punti elenco in una casella di testo; nessuna immagine nella prima versione. Testo con caratteri di controllo tolti e caratteri XML sfuggiti.

## Cornici

Un `iframe` con `srcdoc` eredita la CSP della pagina che lo contiene: quella della chat servita dal core (`script-src 'self'; style-src 'self'`) bloccherebbe gli script e gli stili inline di ogni mockup, e lo script dello Studio. Per questo la pagina costruisce il documento della cornice (meta CSP, script dello Studio, mockup) e lo consegna al core, che lo serve con una CSP sua.

- `POST /api/studio-frames` `{ html, print? }` → `201 { url }`: `url` è `/api/studio-frames/<gettone>` (32 caratteri esadecimali casuali). Al più 3 MiB; tenuto **solo in memoria** per 10 minuti, al più 32 cornici (la più vecchia esce per prima); un riavvio del core le cancella tutte.
- `GET /api/studio-frames/:token` → l'HTML così com'è, `text/html`, con `content-security-policy: sandbox allow-scripts` (più `allow-modals` solo per `print: true`, la cornice della stampa), `default-src 'none'`, script, stili, immagini e font solo inline, `data:` e `blob:`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'self'` e `x-frame-options: SAMEORIGIN`. Nella cornice della stampa la CSP ammette solo lo script di stampa della pagina (`script-src 'sha256-…'`, lo stesso testo di `PRINT_SCRIPT` in `apps/hud/src/lib/studio-frame.ts` e in `apps/core/src/studio-frames.ts`, tenuti uguali da un test): gli script del mockup non girano dove si possono aprire finestre di dialogo. Gettone sconosciuto o scaduto: 404; la pagina ricostruisce la cornice.

## Come la pagina trova le slide

Convenzione del Designer (`agents/designer.md`): una presentazione è un mockup con un elemento `<section data-slide>` per diapositiva. Da ogni sezione la pagina prende: il primo `h1` o `h2` come `title`, il primo `h3` o un elemento `[data-subtitle]` come `subtitle`, i `p` come `paragraphs`, i `li` come `bullets`, un `aside[data-notes]` come `notes`; `background`, `color` e `accent` dagli attributi `data-background`, `data-color` e `data-accent` se ci sono. Un mockup senza `section[data-slide]` non offre «Esporta PPTX».

**Aspetto dello schermo:** prima di esportare la pagina chiede alla cornice del mockup mostrato (messaggio `looks`) come appare ogni `section[data-slide]`: larghezza della sezione, sfondo (il primo non trasparente risalendo), colore del primo `p` o `li` e del primo `h1`/`h2`, loro `font-family` e dimensione in px. La risposta `{ type: 'looks', slides: [...] }` ha forma fissa (al più 200 slide, colori `#rrggbb` o `null`, dimensioni positive fino a 2000, liste di caratteri di al più 300 caratteri) e vale solo se il numero delle slide è quello del sorgente. I colori misurati vincono sugli attributi `data-*`; le dimensioni diventano punti di una slide larga 960 pt; il carattere è il primo con un nome nella lista (`serif` → Times New Roman, `monospace` → Courier New, il sans-serif di sistema resta quello del tema). Uno sfondo semitrasparente non conta (si risale al primo pieno); senza sfondo pieno, o senza risposta entro un secondo, valgono gli attributi. Una slide nascosta (una alla volta a schermo) prende la larghezza della pagina. Le dimensioni seguono la vista mostrata (desktop, tablet o mobile): un titolo che a schermo cresce sul telefono cresce anche nel PPTX. Il carattere è quello nominato dal mockup anche se la cornice, senza rete, non lo carica e mostra il suo sostituto.

## Studio nella pagina (riferimento per `apps/hud`)

- Canvas: `iframe` con `src` a una cornice servita dal core (sezione Cornici) e `sandbox="allow-scripts"` (mai `allow-same-origin`), con in testa un `<meta http-equiv="Content-Security-Policy">` che vieta la rete (`default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`; stili, script e immagini solo inline, `data:` e `blob:`). Lo script dello Studio inserito nel documento della cornice (marcato `data-arianna-studio`) scambia con la pagina solo messaggi `postMessage` di forma fissa: la pagina accetta un messaggio solo se `event.source` è la finestra del suo iframe e la forma è giusta. Gli script del mockup girano nella stessa finestra e possono imitare un messaggio `pick`: la forma è controllata e l'estratto è breve, quindi al più l'utente vede un commento su un elemento che non ha scelto.
- Commenti (O3): selettore CSS dell'elemento, riquadro, tag e un estratto del testo (al più 120 caratteri) arrivano alla pagina; i commenti raccolti partono **insieme**, come un solo messaggio nella conversazione diretta col Designer del progetto, che scrive la variante seguente.
- Modifica diretta (O6): la pagina applica testo (o, per un elemento con testo ed elementi mescolati, i suoi pezzi di testo diretti, `segments`, lasciando gli elementi interni) e stili consentiti (`color`, `background-color`, `font-size`, `font-weight`, `padding`, `margin`, `text-align`, `border-radius`) all'elemento del **sorgente** (letto con `DOMParser`, che non esegue script), riserializza e salva con `PUT .../file` e il `base` letto. Prima controlla che il testo dell'elemento nel sorgente corrisponda all'estratto scelto: se uno script del mockup ha cambiato la pagina, la modifica è rifiutata e va chiesta al Designer. La riserializzazione normalizza il file (entità, tag chiusi, commenti fuori da `<html>`): un ritocco piccolo può dare un diff largo. Il DOM vivo dell'iframe non si salva mai (gli script del mockup lo possono aver cambiato).
- Versioni (O4): le varianti di un `group` in una barra; due varianti affiancate in due iframe.
- PDF (O5): la stampa del browser in una cornice a parte (`print: true`), dove gira solo lo script di stampa.
- Sviluppo: con `pnpm hud:dev` la pagina non ha la CSP del core; Vite manda almeno `frame-src 'self'`, così una cornice non può portare la chat verso un sito esterno.
