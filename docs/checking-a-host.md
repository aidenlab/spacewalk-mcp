# Checking a Host

The deploy scripts check that the Worker and the Viewer page answer. Only a person can check that a Host drives them, so after a deploy that matters to the Hosts, do this by hand. Room, Viewer, Host and Connector are defined in `GLOSSARY.md`.

| Stack | Connector name | MCP server URL |
| --- | --- | --- |
| Dev | `Spacewalk dev` | `https://spacewalk-mcp-dev.3dg.io/mcp` |
| Production | `Spacewalk` | `https://spacewalk-mcp.3dg.io/mcp` |

## Add the Connector

- **Claude desktop:** Settings → Connectors → Add custom connector. Give the name and the Remote MCP server URL from the table, then Add. A Claude Connector belongs to the account, so claude.ai on the web gets it too.
- **ChatGPT:** add a custom connector in ChatGPT's settings with the name and MCP server URL from the table, and authentication set to none. Where ChatGPT keeps custom connectors has moved between releases, so no menu path is given here.

## Check it

In each Host the deploy matters for (Claude desktop, claude.ai, ChatGPT desktop, ChatGPT web), start a new conversation with the Connector enabled, then:

| Do | Passes if |
| --- | --- |
| Say "show me an example chromatin trace". If a card shows, press Open Spacewalk. | A Viewer opens showing a structure |
| Say "switch to ribbon". | The render style changes |
| Say "make the balls bigger". | They get bigger |
| Say "darken the background". | It darkens |
| Change something by hand in the Viewer, such as the render style or the background, then ask the model anything about the view. | The reply mentions your change |
| Ask for a shareable URL and open it in a new tab. | It reopens the same view |

If a check fails, try it without a Host first: `docs/dev-check.md` calls the Worker the way a model would and explains the common errors.
