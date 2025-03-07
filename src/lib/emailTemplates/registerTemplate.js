export function registerTemplate({ companyName, email, password, companyCode, companyAddress, companyVAT, companyContact }) {
    return `
     <!DOCTYPE html>
        <html>
        <head>
        <style>
            body { 
            font-family: Arial, sans-serif; 
            background-color: #f4f4f4; 
            padding: 20px; 
            }

            /* Centering the email content */
            .email-wrapper {
            width: 100%;
            background-color: #f4f4f4;
            padding: 20px 0;
            }

            .email-container {
            width: 100%;
            max-width: 600px;
            background: #ffffff;
            padding: 20px;
            border-radius: 5px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin: 0 auto;
            text-align: left;
            }

            h2 { color: #cdb36c; }
            p { font-size: 16px; color: #333; }
            
            .details {
            background: #f9f9f9;
            padding: 10px;
            border-left: 4px solid #cdb36c;
            margin: 10px 0;
            }

            .footer { 
            font-size: 12px; 
            color: #777; 
            text-align: center; 
            margin-top: 20px; 
            }

            .imgContainer { 
            width: 100%;
            max-width: 600px;
            background: #ffffff;
            padding: 20px;
            overflow: hidden;
            text-align: center;
            }

            img { 
            width: 100%; 
            max-width: 100%; 
            object-fit: contain;
            }
        </style>
        </head>
        <body>

        <!-- Full-width table to center the content -->
        <table class="email-wrapper" role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
            <td align="center">
                <table class="email-container" role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                    <td class="imgContainer">
                    <img src="https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo%20Header%20Banner.png?alt=media&token=fb6ef880-b618-46c5-a1c3-e9bc1dd3690e" />
                    </td>
                </tr>
                <tr>
                    <td>
                    <h2>Welcome to Bevgo, ${companyName}!</h2>
                    <p>Your account has been created successfully. Below are your login details:</p>
                    <div class="details">
                        <p><strong>Email:</strong> ${email}</p>
                        <p><strong>Password:</strong> ${password}</p>
                        <p><strong>Company Code:</strong> ${companyCode}</p>
                    </div>
                    <h3>Company Information</h3>
                    <div class="details">
                        <p><strong>Company Name:</strong> ${companyName}</p>
                        <p><strong>Company Address:</strong> ${companyAddress}</p>
                        <p><strong>Company VAT:</strong> ${companyVAT}</p>
                        <p><strong>Company Contact:</strong> ${companyContact}</p>
                    </div>
                    <p>For any assistance, feel free to contact us.</p>
                    </td>
                </tr>
                <tr>
                    <td class="footer">
                    <p>&copy; 2025 Bevgo. All rights reserved.</p>
                    </td>
                </tr>
                </table>
            </td>
            </tr>
        </table>

        </body>
        </html>
    `;
  }
  