# Specifica della policy di privacy

## Livelli

| Livello | Significato | Esempi | Chi può leggerlo |
| --- | --- | --- | --- |
| L0 | Pubblico | Documentazione open source, pagine web | Qualsiasi esecutore |
| L1 | Interno | Codice proprio non sensibile, appunti di lavoro | Locale e cloud, con log |
| L2 | Privato | Fatture, contratti, documenti personali, codice di clienti sotto NDA | Solo modelli locali |
| L3 | Segreto | Credenziali, chiavi, codici | Nessun modello: solo riferimenti al vault |

## Regole

1. **Default-deny:** un dato senza etichetta è L2.
2. **Contaminazione di sessione:** un agente che legge L2 resta locale per tutta la sessione; il router lo impone.
3. **Etichette solo verso l'alto:** abbassare un'etichetta richiede approvazione esplicita dell'utente, registrata.
4. **Gateway unico:** tutto ciò che va a esecutori cloud passa da `packages/policy`; il gateway blocca L2/L3 e registra ogni uscita (cosa, verso chi, perché).
5. **Codice di clienti con NDA:** L2 finché i contratti non sono stati letti.
6. **Segreti (L3):** mai nel prompt; solo riferimenti (`vault://nome`) risolti dal processo che li usa. Gestione con `sops` + `age`.
7. **Voce:** la telefonia aggiunge un percorso audio nel cloud, quindi nessuna lettura di L2 ad alta voce salvo abilitazione per quella singola chiamata.

## Interfaccia (bozza)

```ts
type Label = 'L0' | 'L1' | 'L2' | 'L3';
interface Labeled<T> { value: T; label: Label; source: string }
function maxLabel(...l: Label[]): Label;
function canSendTo(executor: 'local' | 'cloud', label: Label): boolean;
function gatewayCheck(payload: Labeled<unknown>[], target: ExecutorId): Decision; // allow | block + motivo
```

## Test minimi (vedi `EVALS.md`, gruppo "gateway")

- Payload con un solo frammento L2 verso cloud → bloccato.
- Dato senza etichetta verso cloud → bloccato.
- Sessione contaminata che chiede un esecutore cloud → rifiutata.
- Abbassamento di etichetta senza approvazione → rifiutato.
- Ogni uscita consentita produce una riga di log.
- L3 mai presente nel testo di un prompt.
