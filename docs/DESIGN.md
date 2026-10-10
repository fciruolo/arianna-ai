# Guida di stile di Arianna

La legge il Designer (D-159) prima di ogni mockup di Arianna stessa; vale anche per chi disegna a mano. Viene dai token approvati in D-060 (identità), D-062 (caratteri) e D-103 (temi), che vivono in `apps/hud/src/style.css`: se cambiano lì, questo file va aggiornato.

## Identità

La struttura e la cura di OpenDots (tre colonne, bolle, intestazione con stato, schede, composer) fuse con una HUD stile Jarvis: fondo a griglia, angoli luminosi sulle schede, dati in monospazio, etichette di privacy L0–L3 sempre visibili. **Scura di base**, chiara e calda quando il sistema è chiaro o l'utente lo sceglie. Riferimento approvato: `docs/mockups/arianna-hud.html`.

## Colori

Ogni mockup definisce i colori come variabili su `:root`, con la variante chiara sotto `@media (prefers-color-scheme: light)`.

| Token | Scuro | Chiaro | Uso |
| --- | --- | --- | --- |
| `--bg` | `#0a1316` | `#f5f4f0` | Fondo della pagina |
| `--surface` | `#0e1b1f` | `#fbfaf7` | Schede, pannelli |
| `--surface-2` | `#132429` | `#ffffff` | Campi, blocchi di codice, elementi dentro una scheda |
| `--line` | `#1e363c` | `#e3e4df` | Bordi tenui, separatori |
| `--line-strong` | `#2b4c53` | `#cfd5d0` | Bordi di schede e pulsanti |
| `--ink` | `#dcebe8` | `#24302e` | Testo |
| `--muted` | `#7f9b98` | `#687673` | Testo secondario, titoli di sezione, barre di scorrimento |
| `--accent` | `#4fd1c1` | `#23887c` | Azione principale, angoli delle schede, focus |
| `--accent-ink` | `#062a26` | `#ffffff` | Testo sopra `--accent` |
| `--bubble` | `#2a8f84` | `#3d7e75` | Bolla dei messaggi dell'utente |
| `--bubble-ink` | `#f1fbf9` | `#ffffff` | Testo nella bolla |
| `--glow` | `#4fd1c133` | `#23887c22` | Alone attorno all'agente attivo |
| `--warn` | `#f2b34b` | `#b9801c` | Attesa, avvisi |
| `--danger` | `#e2614b` | `#c24a35` | Errori, azioni distruttive |
| `--ok` | `#7cc796` | `#4e9466` | Riuscito, fatto |
| `--info` | `#7fb4f0` | `#3f6fa8` | Informazioni neutre |
| `--grid` | `#4fd1c10a` | `#23887c0d` | Linee della griglia di fondo |

Etichette di privacy (sempre visibili accanto a un contenuto): **L0** `#7cc796`, **L1** `#4fd1c1`, **L2** `#f2b34b`, **L3** `#e2614b`.

Niente colori fuori da questa tavolozza senza un motivo; niente sfumature decorative, niente ombre pesanti: la profondità viene dai bordi e dagli angoli luminosi.

## Caratteri

| Ruolo | Carattere | Pesi | Uso |
| --- | --- | --- | --- |
| Testo | Figtree | 400, 500, 600 | Corpo, pulsanti, messaggi: `14px/1.55` |
| HUD | Chakra Petch | 500, 600 | Titoli di sezione: maiuscoletto, `10.5px`, spaziatura `0.16em`, colore `--muted` |
| Dati | JetBrains Mono | 400, 500 | Etichette L0–L3, orari, id, codice |

La chat serve i caratteri in locale (D-062); un mockup autonomo **non li carica da Google Fonts né da altri CDN**: scrive la pila con i ripieghi e accetta il carattere di sistema.

```css
--font-sans: "Figtree", -apple-system, "Segoe UI", sans-serif;
--font-hud: "Chakra Petch", "Eurostile", "Arial Narrow", sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
```

## Forme e componenti

- **Fondo:** `--bg` con una griglia di 28 px fatta di due `linear-gradient` di `--grid`.
- **Scheda (`hud-card`):** bordo `1px --line-strong`, raggio 14 px, fondo `--surface`, due angoli luminosi di 12 px (in alto a sinistra e in basso a destra) con bordo `2px --accent`; `--warn` o `--danger` per le schede di attesa o di errore.
- **Pulsante:** raggio 9 px, bordo `--line-strong`, fondo `--surface`, peso 500, padding `8px 14px`, icona e testo con 6 px di spazio; il principale ha fondo `--accent` e testo `--accent-ink`.
- **Etichetta L0–L3:** monospazio 10 px, padding `3px 5px`, raggio 4 px, bordo e testo del colore del livello.
- **Raggi:** 14 px schede, 9 px pulsanti e campi, 4-6 px chip e codice in linea, 999 px pillole.
- **Icone:** tratto lineare (stile Lucide), 16 px nel testo.

## Regole di interazione

- I campi di testo non hanno anello né bordo colorato al focus: basta il cursore. L'anello `2px --accent` con 2 px di distanza resta su pulsanti e link raggiunti da tastiera (`:focus-visible`).
- Barre di scorrimento sottili, senza frecce né binario, pollice arrotondato del colore di `--muted`, visibile solo al passaggio del mouse sull'area.
- Testi dell'interfaccia in italiano, brevi, con verbi d'azione ("Crea le card", "Non ora").
- La pagina funziona da 1280×800 in su; sotto i 768 px una colonna sola.

## Mockup

Un file HTML autonomo in `docs/mockups/` (nel repository di Arianna) o in `mockups/` di un progetto: CSS e JS in linea, immagini come `data:`, nessuna risorsa remota, varianti numerate (`pagina-1.html`, `pagina-2.html`) invece di sovrascrivere. Dati sempre inventati.
