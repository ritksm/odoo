# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import _, api, fields, models
from odoo.exceptions import UserError


class PaymentAcquirer(models.Model):
    _inherit = 'payment.acquirer'

    provider = fields.Selection(selection_add=[('test', 'Test')], ondelete={'test': 'set default'})

    #=== COMPUTE METHODS ===#

    @api.depends('provider')
    def _compute_view_configuration_fields(self):
        """ Override of payment to hide the credentials page.

        :return: None
        """
        super()._compute_view_configuration_fields()
        self.filtered(lambda acq: acq.provider == 'test').show_credentials_page = False

    def _compute_feature_support_fields(self):
        """ Override of `payment` to enable additional features. """
        super()._compute_feature_support_fields()
        self.filtered(lambda acq: acq.provider == 'test').update({
            'support_tokenization': True,
        })

    # === CONSTRAINT METHODS ===#

    @api.constrains('state', 'provider')
    def _check_acquirer_state(self):
        if self.filtered(lambda a: a.provider == 'test' and a.state not in ('test', 'disabled')):
            raise UserError(_("Test acquirers should never be enabled."))

    def _get_default_payment_method_id(self):
        self.ensure_one()
        if self.provider != 'test':
            return super()._get_default_payment_method_id()
        return self.env.ref('payment_test.payment_method_test').id
