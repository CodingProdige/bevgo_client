export function orderStatusTemplate({ orderId, status, estimatedDelivery, customerName }) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px; }
          .container { max-width: 600px; background: #ffffff; padding: 20px; border-radius: 5px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h2 { color: #0056b3; }
          p { font-size: 16px; color: #333; }
          .details { background: #f9f9f9; padding: 10px; border-left: 4px solid #0056b3; margin: 10px 0; }
          .footer { font-size: 12px; color: #777; text-align: center; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Hello ${customerName},</h2>
          <p>Your order <strong>#${orderId}</strong> is now <strong>${status}</strong>.</p>
          <p>Estimated Delivery: <strong>${estimatedDelivery}</strong></p>
          <div class="footer">
            <p>&copy; 2025 Bevgo. Thank you for your order!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
  