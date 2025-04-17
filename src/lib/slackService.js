export async function sendSlackMessage(text) {
    const webhookURL = process.env.SLACK_WEBHOOK_URL;
  
    if (!webhookURL) {
      console.error("Slack Webhook URL missing");
      return;
    }
  
    await fetch(webhookURL, {
      method: "POST",
      body: JSON.stringify({ text }),
      headers: { "Content-Type": "application/json" },
    });
  }
  