const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendEmail({ to, subject, html }) {
  try {
    const info = await transporter.sendMail({
      from: `"Dar Al-Ilm" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });

    console.log('Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email sending failed:', error);
    return { success: false, error: error.message };
  }
}

function getPasswordResetEmailTemplate(resetUrl, userName) {
  return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Réinitialisation de mot de passe</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f3f4f6;">
      <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td align="center" style="padding: 40px 0;">
            <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              
              <!-- Header -->
              <tr>
                <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #0891b2 0%, #2563eb 100%); border-radius: 12px 12px 0 0;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: bold;">
                    🔐 Réinitialisation de mot de passe
                  </h1>
                </td>
              </tr>

              <!-- Content -->
              <tr>
                <td style="padding: 40px;">
                  <p style="margin: 0 0 20px; color: #374151; font-size: 16px; line-height: 1.5;">
                    Bonjour <strong>${userName}</strong>,
                  </p>
                  
                  <p style="margin: 0 0 20px; color: #374151; font-size: 16px; line-height: 1.5;">
                    Vous avez demandé la réinitialisation de votre mot de passe pour votre compte <strong>Dar Al-Ilm</strong>.
                  </p>

                  <p style="margin: 0 0 30px; color: #374151; font-size: 16px; line-height: 1.5;">
                    Cliquez sur le bouton ci-dessous pour créer un nouveau mot de passe :
                  </p>

                  <!-- Button -->
                  <table role="presentation" style="margin: 0 auto 30px; border-collapse: collapse;">
                    <tr>
                      <td style="border-radius: 8px; background: linear-gradient(135deg, #0891b2 0%, #2563eb 100%);">
                        <a href="${resetUrl}" style="display: inline-block; padding: 16px 40px; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: bold; border-radius: 8px;">
                          Réinitialiser mon mot de passe
                        </a>
                      </td>
                    </tr>
                  </table>

                  <!-- Security Notice -->
                  <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.5;">
                      ⚠️ <strong>Important :</strong> Ce lien expirera dans <strong>1 heure</strong>.
                    </p>
                  </div>

                  <p style="margin: 20px 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">
                    Si vous n'avez pas demandé cette réinitialisation, veuillez ignorer cet email. Votre mot de passe restera inchangé.
                  </p>

                  <!-- Fallback Link -->
                  <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
                    <p style="margin: 0 0 10px; color: #6b7280; font-size: 12px; line-height: 1.5;">
                      Si le bouton ne fonctionne pas, copiez et collez ce lien dans votre navigateur :
                    </p>
                    <p style="margin: 0; color: #2563eb; font-size: 12px; word-break: break-all;">
                      ${resetUrl}
                    </p>
                  </div>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="padding: 30px 40px; background-color: #f9fafb; border-radius: 0 0 12px 12px; text-align: center;">
                  <p style="margin: 0 0 10px; color: #6b7280; font-size: 14px;">
                    Cordialement,<br>
                    <strong style="color: #0891b2;">L'équipe Dar Al-Ilm</strong>
                  </p>
                  <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                    © ${new Date().getFullYear()} Dar Al-Ilm. Tous droits réservés.
                  </p>
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

module.exports = {
  sendEmail,
  getPasswordResetEmailTemplate,
};
