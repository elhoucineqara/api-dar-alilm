const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

function stripHtmlForText(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sendEmail({ to, subject, html, attachments = [] }) {
  try {
    const info = await transporter.sendMail({
      from: `"Dar Al-Ilm" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
      text: stripHtmlForText(html),
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    console.log('Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email sending failed:', error);
    return { success: false, error: error.message };
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeStyleAttribute(styleValue = '') {
  const allowedProperties = new Set([
    'background',
    'background-color',
    'border',
    'border-left',
    'border-collapse',
    'border-radius',
    'color',
    'display',
    'font-size',
    'font-style',
    'font-weight',
    'height',
    'line-height',
    'list-style-type',
    'margin',
    'margin-bottom',
    'margin-left',
    'margin-top',
    'max-width',
    'padding',
    'padding-left',
    'text-align',
    'text-decoration',
    'width',
  ]);

  return String(styleValue)
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .map((declaration) => {
      const separatorIndex = declaration.indexOf(':');
      if (separatorIndex === -1) {
        return null;
      }

      const property = declaration.slice(0, separatorIndex).trim().toLowerCase();
      const value = declaration.slice(separatorIndex + 1).trim();
      if (!allowedProperties.has(property)) {
        return null;
      }

      if (!/^[#%,.()\-\/\s\w]+$/i.test(value)) {
        return null;
      }

      return `${property}:${value}`;
    })
    .filter(Boolean)
    .join(';');
}

function sanitizeUrlAttribute(url = '') {
  const value = String(url || '').trim();
  if (!value) {
    return '';
  }

  const normalizedValue = value.toLowerCase();
  if (
    normalizedValue.startsWith('javascript:') ||
    normalizedValue.startsWith('vbscript:') ||
    normalizedValue.startsWith('data:')
  ) {
    return '';
  }

  return value;
}

function sanitizeAdminEmailHtml(html = '') {
  const allowedTags = new Set([
    'a',
    'b',
    'blockquote',
    'br',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'i',
    'img',
    'li',
    'ol',
    'p',
    'span',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ]);

  const rawHtml = String(html || '');
  if (!rawHtml.trim()) {
    return '';
  }

  let sanitized = rawHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link)[^>]*>/gi, '');

  sanitized = sanitized.replace(/<\/?([a-z0-9-]+)([^>]*)>/gi, (fullMatch, tagName, rawAttributes) => {
    const normalizedTag = String(tagName || '').toLowerCase();
    const isClosingTag = fullMatch.startsWith('</');

    if (!allowedTags.has(normalizedTag)) {
      return '';
    }

    if (isClosingTag) {
      return `</${normalizedTag}>`;
    }

    const allowedAttributes = [];
    const attributePattern = /([a-z0-9:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    let attributeMatch;

    while ((attributeMatch = attributePattern.exec(rawAttributes || '')) !== null) {
      const attributeName = String(attributeMatch[1] || '').toLowerCase();
      const attributeValue =
        attributeMatch[3] || attributeMatch[4] || attributeMatch[5] || '';

      if (attributeName.startsWith('on')) {
        continue;
      }

      if (attributeName === 'style') {
        const safeStyle = sanitizeStyleAttribute(attributeValue);
        if (safeStyle) {
          allowedAttributes.push(`style="${escapeHtml(safeStyle)}"`);
        }
        continue;
      }

      if (attributeName === 'href' && normalizedTag === 'a') {
        const safeHref = sanitizeUrlAttribute(attributeValue);
        if (safeHref) {
          allowedAttributes.push(`href="${escapeHtml(safeHref)}"`);
          allowedAttributes.push('target="_blank"');
          allowedAttributes.push('rel="noopener noreferrer"');
        }
        continue;
      }

      if (attributeName === 'src' && normalizedTag === 'img') {
        const safeSrc = sanitizeUrlAttribute(attributeValue);
        if (safeSrc) {
          allowedAttributes.push(`src="${escapeHtml(safeSrc)}"`);
        }
        continue;
      }

      if (attributeName === 'alt' && normalizedTag === 'img') {
        allowedAttributes.push(`alt="${escapeHtml(attributeValue)}"`);
        continue;
      }

      if (
        ['colspan', 'rowspan', 'width', 'height'].includes(attributeName) &&
        ['table', 'td', 'th', 'img'].includes(normalizedTag)
      ) {
        allowedAttributes.push(`${attributeName}="${escapeHtml(attributeValue)}"`);
      }
    }

    const serializedAttributes =
      allowedAttributes.length > 0 ? ` ${allowedAttributes.join(' ')}` : '';

    return normalizedTag === 'img'
      ? `<${normalizedTag}${serializedAttributes} />`
      : `<${normalizedTag}${serializedAttributes}>`;
  });

  return sanitized.trim();
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

function getAdminContactEmailTemplate({
  platformName = 'QaraNetwork',
  recipientName = 'Utilisateur',
  adminName = 'Administrateur',
  subject = 'Message de la plateforme',
  message = '',
  messageHtml = '',
  senderContext = "l'espace administration",
  supportEmail = '',
}) {
  const safeMessageHtml = sanitizeAdminEmailHtml(messageHtml);
  const safeMessage = safeMessageHtml || escapeHtml(message).replace(/\r?\n/g, '<br>');
  const safeSubject = escapeHtml(subject);
  const safeRecipientName = escapeHtml(recipientName);
  const safeAdminName = escapeHtml(adminName);
  const safePlatformName = escapeHtml(platformName);
  const safeSenderContext = escapeHtml(senderContext);
  const safeSupportEmail = escapeHtml(supportEmail);

  return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${safeSubject}</title>
    </head>
    <body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f3f4f6;">
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          <td align="center" style="padding:40px 0;">
            <table role="presentation" style="width:600px;max-width:100%;border-collapse:collapse;background:#ffffff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.1);overflow:hidden;">
              <tr>
                <td style="padding:32px 40px;background:linear-gradient(135deg,#0891b2 0%,#2563eb 100%);color:#ffffff;">
                  <p style="margin:0;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.9;">${safePlatformName}</p>
                  <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;">${safeSubject}</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:40px;">
                  <p style="margin:0 0 18px;color:#374151;font-size:16px;line-height:1.6;">
                    Bonjour <strong>${safeRecipientName}</strong>,
                  </p>
                  <div style="margin:0 0 24px;color:#374151;font-size:16px;line-height:1.7;">
                    ${safeMessage}
                  </div>
                  <div style="padding:16px 18px;border-radius:10px;background:#eff6ff;color:#1e3a8a;font-size:14px;line-height:1.6;">
                    Ce message vous a ete envoye par <strong>${safeAdminName}</strong> depuis ${safeSenderContext} de ${safePlatformName}.
                  </div>
                  ${
                    safeSupportEmail
                      ? `<p style="margin:24px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Si vous avez besoin d'aide, vous pouvez repondre a cet email ou contacter <strong>${safeSupportEmail}</strong>.</p>`
                      : ''
                  }
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
  getAdminContactEmailTemplate,
  sendEmail,
  getPasswordResetEmailTemplate,
  sanitizeAdminEmailHtml,
};
