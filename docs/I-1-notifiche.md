# I-1, notifiche delle risposte (disegno, D-126)

Idea I-1 di `docs/PROPOSTE.md` con le scelte dell'utente del 2026-10-05: browser e telefono; tipi scelti in Impostazioni (risposte, approvazioni in attesa, lavori falliti) e ore di silenzio; la notifica non porta mai il testo né il titolo della conversazione.

## Cosa notifica

Il core ascolta il flusso degli eventi (`createNotifier` in `apps/core/src/notifications.ts`) e ne riconosce tre, solo dai metadati:

| Evento | Tipo | Frase fissa |
| --- | --- | --- |
| `message.created` di Arianna (`role = assistant`), non di un agente delegato né di una chiamata | `reply` | Arianna ha risposto |
| `approval.requested` | `approval` | Arianna aspetta una tua decisione |
| `task.failed` | `failure` | Un lavoro è fallito |

La conversazione di un'approvazione o di un fallimento si legge da `tasks.conversation_id`. Un avviso è solo `{ kind, conversationId }`: niente testo, titolo, etichetta, agente.

## Dove arriva

1. **Pagine aperte.** Il core manda l'avviso a ogni pagina collegata al WebSocket (`{ "type": "notice", "kind", "conversationId" }`). La pagina mostra la notifica del browser (`Notification`, o `showNotification` del service worker se c'è) quando l'utente ha dato il permesso e la pagina è nascosta o fuori fuoco, oppure quando l'avviso è di un'altra conversazione. Un clic apre `/c/<id>`.
2. **Chat chiusa: Web Push.** Se nessuna pagina è in primo piano e `[voice.push]` è configurato, il core manda una push vuota come per le chiamate (D-066): senza corpo, solo l'intestazione VAPID, `ttl` 3600, `urgency: normal`, `topic: arianna-<tipo>` (una push nuova dello stesso tipo sostituisce quella non ancora consegnata). Prima, il gateway controlla sul canale `push` la frase fissa del tipo (L0), come per "Arianna ti chiama".
3. **Il service worker** (`apps/hud/public/sw.js`), ricevuta la push, chiede al core `GET /api/notifications/latest`: l'ultimo avviso spinto (tipo e id della conversazione, tenuto in memoria per un'ora) e scrive la frase fissa. La domanda va dal dispositivo al core, mai dal servizio push. Se il core non risponde scrive "Arianna — Apri la chat per vedere le novità." (i browser vogliono comunque una notifica). Le chiamate usano la stessa strada: il ringer registra `call` prima della push.

## In primo piano o no

Ogni pagina dice al core se è visibile (`document.visibilityState`) con l'unico messaggio che il WebSocket accetta: `{"type":"visibility","visible":true|false}`; qualsiasi altro messaggio chiude il socket come prima (1008). Il core conta le pagine visibili: con almeno una, niente push (evita il doppio). Una pagina nascosta riceve comunque l'avviso e mostra la sua notifica; sullo stesso browser la notifica della pagina e quella della push hanno lo stesso `tag` (`arianna-<tipo>-<conversazione>`) e si sostituiscono.

## Impostazioni

Sezione ordinaria `[notifications]` di `config/arianna.toml`, letta senza riavvio:

```toml
[notifications]
replies = true
approvals = true
failures = true
quiet = "22:00-07:00"   # ora locale, anche a cavallo della mezzanotte; senza la chiave nessun silenzio
```

Senza la sezione: tutti i tipi accesi, nessun silenzio. Le ore di silenzio fermano sia la pagina sia la push; le chiamate restano con i loro orari di `[voice.outgoing]`. Nella chat: Impostazioni → Agenti e voce → **Notifiche**, con i tre interruttori e le ore di silenzio (salvati in `arianna.toml`) e il riquadro **Questo dispositivo**, che chiede il permesso del browser e iscrive il dispositivo alla push. Il permesso si chiede solo dal clic.

## Privacy

- Nessun dato L1/L2 esce: la push è vuota; il gateway vede e registra solo le quattro frasi fisse L0.
- `GET /api/notifications/latest` risponde con tipo e UUID della conversazione, alle stesse condizioni di ogni altra rotta del core (loopback, stesso Host).
- Telegram è spento (D-110) e non riceve questi avvisi.

## Limiti

- **Telefono:** la push e il service worker chiedono HTTPS; il core oggi ascolta solo su loopback in http. Dal telefono servono VPN e proxy HTTPS (task 1.13), non ancora attivi. Sul Mac, `http://127.0.0.1` vale come contesto sicuro e tutto funziona.
- Due avvisi a pochi secondi l'uno dall'altro: il service worker legge l'ultimo, quindi la prima push può mostrare il testo del secondo (stesse frasi fisse, link alla conversazione più recente).
- L'ultimo avviso vive in memoria: un riavvio del core lo dimentica e la push arrivata dopo mostra la frase generica.
- Una pagina visibile ma dietro un'altra finestra conta come "in primo piano" per il core (niente push); la pagina stessa però mostra la notifica perché non ha il fuoco.
