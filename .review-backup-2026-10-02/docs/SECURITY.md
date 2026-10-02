# Sicurezza

| Minaccia | Controllo |
| --- | --- |
| Fuga di dati L2/L3 verso il cloud | Gateway unico, default-deny, contaminazione di sessione, log delle uscite, eval al 100% |
| Prompt injection da contenuti non fidati | Lethal trifecta rimosso per scheda; Dual LLM; nessun invio esterno senza approvazione |
| Agente che esegue comandi dannosi | Permessi minimi (`--allowedTools`), sandbox (Docker Sandboxes o sandbox-runtime), hook che blocca letture fuori repo |
| Furto o abuso delle credenziali | `sops` + `age`; nessun token OAuth estratto; L3 solo come riferimenti |
| Costi o cicli fuori controllo | Tetti di passi, tempo, costo/quota per task; scheduler deterministico |
| Accesso remoto al server | VPN (WireGuard o Tailscale), nessuna porta esposta, autenticazione sull'HUD |
| Chiamate telefoniche | Audio nel cloud: nessuna lettura di L2 salvo abilitazione per chiamata; numeri ammessi in lista |
| Cambio regole degli abbonamenti | Adattatori sostituibili, test di contratto, controllo periodico delle pagine ufficiali |
| Perdita di dati | Backup cifrati di archivio, KB e database; ripristino provato in Fase 2 |

## Regole di sviluppo

- Dati finti ovunque in sviluppo; i dati veri entrano solo dopo il criterio di uscita della Fase 1.
- Gli hook in `.claude/settings.json` negano lettura/scrittura fuori dal repository e su file di segreti.
- Ogni azione esterna o irreversibile è registrata e, salvo autonomia esplicita, approvata.
- Il blocco delle letture fuori dal repository è affidato all'hook `.claude/hooks/block-outside-repo.js`; nei permessi non si usano divieti larghi come `Read(~/**)`, perché il repository stesso sta nella home e resterebbe illeggibile. Verificare l'hook nel task 0.5.
