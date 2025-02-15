# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

import base64

from unittest.mock import patch

from odoo import tools
from odoo.addons.mail.tests.common import mail_new_test_user
from odoo.addons.test_mail.data.test_mail_data import MAIL_TEMPLATE_PLAINTEXT
from odoo.addons.test_mail.models.test_mail_models import MailTestSimple
from odoo.addons.test_mail.tests.common import TestMailCommon, TestRecipients
from odoo.api import call_kw
from odoo.exceptions import AccessError
from odoo.tests import tagged
from odoo.tools import mute_logger, formataddr
from odoo.tests.common import users

from markupsafe import escape


@tagged('mail_post')
class TestMessagePostCommon(TestMailCommon, TestRecipients):

    @classmethod
    def setUpClass(cls):
        super(TestMessagePostCommon, cls).setUpClass()

        # portal user, notably for ACLS / notifications
        cls.user_portal = cls._create_portal_user()
        cls.partner_portal = cls.user_portal.partner_id

        # another standard employee to test follow and notifications between two
        # users (and not admin / user)
        cls.user_employee_2 = mail_new_test_user(
            cls.env, login='employee2',
            groups='base.group_user',
            company_id=cls.company_admin.id,
            email='eglantine@example.com',  # check: use a formatted email
            name='Eglantine Employee2',
            notification_type='email',
            signature='--\nEglantine',
        )
        cls.partner_employee_2 = cls.user_employee_2.partner_id

        cls.test_record = cls.env['mail.test.simple'].with_context(cls._test_context).create({
            'name': 'Test',
            'email_from': 'ignasse@example.com'
        })
        cls._reset_mail_context(cls.test_record)
        cls.test_message = cls.env['mail.message'].create({
            'author_id': cls.partner_employee.id,
            'body': '<p>Notify Body <span>Woop Woop</span></p>',
            'email_from': cls.partner_employee.email_formatted,
            'is_internal': False,
            'message_id': tools.generate_tracking_message_id('dummy-generate'),
            'message_type': 'comment',
            'model': cls.test_record._name,
            'record_name': False,
            'reply_to': 'wrong.alias@test.example.com',
            'subtype_id': cls.env['ir.model.data']._xmlid_to_res_id('mail.mt_comment'),
            'subject': 'Notify Test',
        })
        cls.user_admin.write({'notification_type': 'email'})

    def setUp(self):
        super(TestMessagePostCommon, self).setUp()
        # send tracking and messages + patch registry to simulate a ready environment
        # purpose is to avoid nondeterministic tests, notably because tracking is
        # accumulated and sent at flush -> we want to test only the result of a
        # given test, not setup + test
        self.flush_tracking()
        # see ``_message_auto_subscribe_notify``
        self.patch(self.env.registry, 'ready', True)


@tagged('mail_post')
class TestMailNotifyAPI(TestMessagePostCommon):

    @users('employee')
    def test_email_notifiction_layouts(self):
        self.user_employee.write({'notification_type': 'email'})
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)
        test_message = self.env['mail.message'].browse(self.test_message.ids)

        recipients_data = self._generate_notify_recipients(self.partner_1 + self.partner_2 + self.partner_employee)
        for email_xmlid in ['mail.message_notification_email',
                            'mail.mail_notification_light',
                            'mail.mail_notification_paynow']:
            test_message.sudo().notification_ids.unlink()  # otherwise partner/message constraint fails
            test_message.write({'email_layout_xmlid': email_xmlid})
            with self.mock_mail_gateway():
                test_record._notify_thread_by_email(
                    test_message,
                    recipients_data,
                    force_send=False
                )
            self.assertEqual(len(self._new_mails), 2, 'Should have 2 emails: one for customers, one for internal users')

            # check customer email
            customer_email = self._new_mails.filtered(lambda mail: mail.recipient_ids == self.partner_1 + self.partner_2)
            self.assertTrue(customer_email)

            # check internal user email
            user_email = self._new_mails.filtered(lambda mail: mail.recipient_ids == self.partner_employee)
            self.assertTrue(user_email)

    @users('employee')
    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_notify_by_mail_add_signature(self):
        test_track = self.env['mail.test.track'].with_context(self._test_context).with_user(self.user_employee).create({
            'name': 'Test',
            'email_from': 'ignasse@example.com'
        })
        test_track.user_id = self.env.user

        signature = self.env.user.signature

        template = self.env.ref('mail.mail_notification_paynow', raise_if_not_found=True).sudo()
        self.assertIn("record.user_id.sudo().signature", template.arch)

        with self.mock_mail_gateway():
            test_track.message_post(
                body="Test body",
                email_add_signature=True,
                email_layout_xmlid="mail.mail_notification_paynow",
                mail_auto_delete=False,
                partner_ids=[self.partner_1.id, self.partner_2.id],
            )
        found_mail = self._new_mails
        self.assertIn(signature, found_mail.body_html)
        self.assertEqual(found_mail.body_html.count(signature), 1)

        with self.mock_mail_gateway():
            test_track.message_post(
                body="Test body",
                email_add_signature=False,
                email_layout_xmlid="mail.mail_notification_paynow",
                mail_auto_delete=False,
                partner_ids=[self.partner_1.id, self.partner_2.id],
            )
        found_mail = self._new_mails
        self.assertNotIn(signature, found_mail.body_html)
        self.assertEqual(found_mail.body_html.count(signature), 0)

    @users('employee')
    def test_notify_by_email_add_signature_no_author_user_or_no_user(self):
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)
        test_message = self.env['mail.message'].browse(self.test_message.ids)
        test_message.write({
            'author_id': self.env['res.partner'].sudo().create({
                'name': 'Steve',
            }).id
        })
        template_values = test_record._notify_by_email_prepare_rendering_context(test_message, {})
        self.assertNotEqual(escape(template_values['signature']), escape('<p>-- <br/>Steve</p>'))

        self.test_message.author_id = None
        template_values = test_record._notify_by_email_prepare_rendering_context(test_message, {})
        self.assertEqual(template_values['signature'], '')

    @users('employee')
    def test_notify_by_email_prepare_rendering_context(self):
        """ Verify that the template context company value is right
        after switching the env company or if a company_id is set
        on mail record.
        """
        current_user = self.env.user
        main_company = current_user.company_id
        other_company = self.env['res.company'].with_user(self.user_admin).create({'name': 'Company B'})
        current_user.sudo().write({'company_ids': [(4, other_company.id)]})
        test_record = self.env['mail.test.multi.company'].with_user(self.user_admin).create({
            'name': 'Multi Company Record',
            'company_id': False,
        })

        # self.env.company.id = Main Company    AND    test_record.company_id = False
        self.assertEqual(self.env.company.id, main_company.id)
        self.assertEqual(test_record.company_id.id, False)
        template_values = test_record._notify_by_email_prepare_rendering_context(test_record.message_ids, {})
        self.assertEqual(template_values.get('company').id, self.env.company.id)

        # self.env.company.id = Other Company    AND    test_record.company_id = False
        current_user.company_id = other_company
        test_record = self.env['mail.test.multi.company'].browse(test_record.id)
        self.assertEqual(self.env.company.id, other_company.id)
        self.assertEqual(test_record.company_id.id, False)
        template_values = test_record._notify_by_email_prepare_rendering_context(test_record.message_ids, {})
        self.assertEqual(template_values.get('company').id, self.env.company.id)

        # self.env.company.id = Other Company    AND    test_record.company_id = Main Company
        test_record.company_id = main_company
        test_record = self.env['mail.test.multi.company'].browse(test_record.id)
        self.assertEqual(self.env.company.id, other_company.id)
        self.assertEqual(test_record.company_id.id, main_company.id)
        template_values = test_record._notify_by_email_prepare_rendering_context(test_record.message_ids, {})
        self.assertEqual(template_values.get('company').id, main_company.id)

    def test_notify_recipients_internals(self):
        pdata = self._generate_notify_recipients(self.partner_1 | self.partner_employee)
        msg_vals = {
            'body': 'Message body',
            'model': self.test_record._name,
            'res_id': self.test_record.id,
            'subject': 'Message subject',
        }
        link_vals = {
            'token': 'token_val',
            'access_token': 'access_token_val',
            'auth_signup_token': 'auth_signup_token_val',
            'auth_login': 'auth_login_val',
        }
        notify_msg_vals = dict(msg_vals, **link_vals)
        classify_res = self.env[self.test_record._name]._notify_get_recipients_classify(pdata, 'My Custom Model Name', msg_vals=notify_msg_vals)
        # find back information for each recipients
        partner_info = next(item for item in classify_res if item['recipients'] == self.partner_1.ids)
        emp_info = next(item for item in classify_res if item['recipients'] == self.partner_employee.ids)

        # partner: no access button
        self.assertFalse(partner_info['has_button_access'])

        # employee: access button and link
        self.assertTrue(emp_info['has_button_access'])
        for param, value in link_vals.items():
            self.assertIn('%s=%s' % (param, value), emp_info['button_access']['url'])
        self.assertIn('model=%s' % self.test_record._name, emp_info['button_access']['url'])
        self.assertIn('res_id=%s' % self.test_record.id, emp_info['button_access']['url'])
        self.assertNotIn('body', emp_info['button_access']['url'])
        self.assertNotIn('subject', emp_info['button_access']['url'])

        # test when notifying on non-records (e.g. MailThread._message_notify())
        for model, res_id in ((self.test_record._name, False),
                              (self.test_record._name, 0),  # browse(0) does not return a valid recordset
                              (False, self.test_record.id),
                              (False, False),
                              ('mail.thread', False),
                              ('mail.thread', self.test_record.id)):
            msg_vals.update({
                'model': model,
                'res_id': res_id,
            })
            # note that msg_vals wins over record on which method is called
            notify_msg_vals = dict(msg_vals, **link_vals)
            classify_res = self.test_record._notify_get_recipients_classify(
                pdata, 'Test', msg_vals=notify_msg_vals)
            # find back information for partner
            partner_info = next(item for item in classify_res if item['recipients'] == self.partner_1.ids)
            emp_info = next(item for item in classify_res if item['recipients'] == self.partner_employee.ids)
            # check there is no access button
            self.assertFalse(partner_info['has_button_access'])
            self.assertFalse(emp_info['has_button_access'])

            # test on falsy records (False model cannot be browsed, skipped)
            if model:
                record_falsy = self.env[model].browse(res_id)
                classify_res = record_falsy._notify_get_recipients_classify(
                    pdata, 'Test', msg_vals=notify_msg_vals)
                # find back information for partner
                partner_info = next(item for item in classify_res if item['recipients'] == self.partner_1.ids)
                emp_info = next(item for item in classify_res if item['recipients'] == self.partner_employee.ids)
                # check there is no access button
                self.assertFalse(partner_info['has_button_access'])
                self.assertFalse(emp_info['has_button_access'])


@tagged('mail_post', 'mail_notify')
class TestMessageNotify(TestMessagePostCommon):

    @users('employee')
    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_notify(self):
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)

        with self.mock_mail_gateway():
            new_notification = test_record.message_notify(
                body='<p>You have received a notification</p>',
                partner_ids=[self.partner_1.id, self.partner_admin.id, self.partner_employee_2.id],
                subject='This should be a subject',
            )

        self.assertMessageFields(
            new_notification,
            {'author_id': self.partner_employee,
             'body': '<p>You have received a notification</p>',
             'email_from': formataddr((self.partner_employee.name, self.partner_employee.email_normalized)),
             'message_type': 'user_notification',
             'model': test_record._name,
             'notified_partner_ids': self.partner_1 | self.partner_employee_2 | self.partner_admin,
             'res_id': test_record.id,
             'subtype_id': self.env.ref('mail.mt_note'),
            }
        )
        self.assertNotIn(new_notification, self.test_record.message_ids)

        admin_mails = [mail for mail in self._mails if self.partner_admin.name in mail.get('email_to')[0]]
        self.assertEqual(len(admin_mails), 1, 'There should be exactly one email sent to admin')
        admin_mail_body = admin_mails[0].get('body')
        admin_access_link = admin_mail_body[admin_mail_body.index('model='):admin_mail_body.index('/>') - 1] if 'model=' in admin_mail_body else None

        self.assertIsNotNone(admin_access_link, 'The email sent to admin should contain an access link')
        self.assertIn('model=%s' % self.test_record._name, admin_access_link, 'The access link should contain a valid model argument')
        self.assertIn('res_id=%d' % self.test_record.id, admin_access_link, 'The access link should contain a valid res_id argument')

        partner_mails = [x for x in self._mails if self.partner_1.name in x.get('email_to')[0]]
        self.assertEqual(len(partner_mails), 1, 'There should be exactly one email sent to partner')
        partner_mail_body = partner_mails[0].get('body')
        self.assertNotIn('/mail/view?model=', partner_mail_body, 'The email sent to customer should not contain an access link')

    @users('employee')
    def test_notify_batch(self):
        """ Test notify in batch. Currently not supported. """
        test_records, _partners = self._create_records_for_batch('mail.test.simple', 10)

        with self.assertRaises(ValueError):
            test_records.message_notify(
                body='<p>Nice notification content</p>',
                partner_ids=self.partner_employee_2.ids,
                subject='Notify Subject',
            )

    @users('employee')
    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_notify_from_user_id(self):
        """ Test notify coming from user_id assignment. """
        test_record = self.env['mail.test.track'].create({
            'company_id': self.env.user.company_id.id,
            'email_from': self.env.user.email_formatted,
            'name': 'Test UserId Track',
            'user_id': False,
        })
        self.flush_tracking()

        with self.mock_mail_gateway(), self.mock_mail_app():
            test_record.write({'user_id': self.user_employee_2.id})
            self.flush_tracking()

        self.assertEqual(len(self._new_msgs), 2, 'Should have 2 messages: tracking and assignment')
        assign_notif = self._new_msgs.filtered(lambda msg: msg.message_type == 'user_notification')
        self.assertTrue(assign_notif)
        self.assertMessageFields(
            assign_notif,
            {'author_id': self.partner_employee,
             'email_from': formataddr((self.partner_employee.name, self.partner_employee.email_normalized)),
             'model': test_record._name,
             'notified_partner_ids': self.partner_employee_2,
             'res_id': test_record.id,
             'subtype_id': self.env.ref('mail.mt_note'),
            }
        )
        self.assertIn('Dear %s' % self.partner_employee_2.name, assign_notif.body)

    @users('employee')
    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_notify_from_user_id_batch(self):
        """ Test notify coming from user_id assignment. """
        test_records, _ = self._create_records_for_batch(
            'mail.test.track', 10, {
                'company_id': self.env.user.company_id.id,
                'email_from': self.env.user.email_formatted,
                'user_id': False,
            }
        )
        test_records = self.env['mail.test.track'].browse(test_records.ids)
        self.flush_tracking()

        with self.mock_mail_gateway(), self.mock_mail_app():
            test_records.write({'user_id': self.user_employee_2.id})
            self.flush_tracking()

        self.assertEqual(len(self._new_msgs), 20, 'Should have 20 messages: 10 tracking and 10 assignments')
        for test_record in test_records:
            assign_notif = self._new_msgs.filtered(lambda msg: msg.message_type == 'user_notification' and msg.res_id == test_record.id)
            self.assertTrue(assign_notif)
            self.assertMessageFields(
                assign_notif,
                {'author_id': self.partner_employee,
                 'email_from': formataddr((self.partner_employee.name, self.partner_employee.email_normalized)),
                 'model': test_record._name,
                 'notified_partner_ids': self.partner_employee_2,
                 'res_id': test_record.id,
                 'subtype_id': self.env.ref('mail.mt_note'),
                }
            )

    @users('employee')
    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_notify_thread(self):
        """ Test notify on ``mail.thread`` model, which is pushing a message to
        people without having a document. """
        with self.mock_mail_gateway():
            new_notification = self.env['mail.thread'].message_notify(
                body='<p>You have received a notification</p>',
                partner_ids=[self.partner_1.id, self.partner_admin.id, self.partner_employee_2.id],
                subject='This should be a subject',
            )

        self.assertMessageFields(
            new_notification,
            {'author_id': self.partner_employee,
             'body': '<p>You have received a notification</p>',
             'email_from': formataddr((self.partner_employee.name, self.partner_employee.email_normalized)),
             'message_type': 'user_notification',
             'model': False,
             'res_id': False,
             'notified_partner_ids': self.partner_1 | self.partner_employee_2 | self.partner_admin,
             'subtype_id': self.env.ref('mail.mt_note'),
            }
        )


@tagged('mail_post')
class TestMessagePost(TestMessagePostCommon):

    def test_initial_values(self):
        self.assertFalse(self.test_record.message_ids)
        self.assertFalse(self.test_record.message_follower_ids)
        self.assertFalse(self.test_record.message_partner_ids)

    @users('employee')
    def test_message_log(self):
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)
        test_record.message_subscribe(self.partner_employee_2.ids)

        new_note = test_record._message_log(
            body='<p>Labrador</p>',
        )
        self.assertMessageFields(
            new_note,
            {'author_id': self.partner_employee,
             'body': '<p>Labrador</p>',
             'email_from': formataddr((self.partner_employee.name, self.partner_employee.email_normalized)),
             'is_internal': True,
             'message_type': 'notification',
             'model': test_record._name,
             'notified_partner_ids': self.env['res.partner'],
             'reply_to': formataddr((self.company_admin.name, '%s@%s' % (self.alias_catchall, self.alias_domain))),
             'res_id': test_record.id,
             'subtype_id': self.env.ref('mail.mt_note'),
            }
        )

    @mute_logger('odoo.addons.mail.models.mail_mail', 'odoo.models.unlink')
    @users('employee')
    def test_message_post(self):
        self.user_employee_2.write({'notification_type': 'inbox'})
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)

        with self.assertSinglePostNotifications(
                [{'partner': self.partner_employee_2, 'type': 'inbox'}],
                {'content': 'Body'}
            ):
            new_message = test_record.message_post(
                body='Body',
                message_type='comment',
                subtype_xmlid='mail.mt_comment',
                partner_ids=[self.partner_employee_2.id],
            )

        self.assertMessageFields(
            new_message,
            {'author_id': self.partner_employee,
             'body': '<p>Body</p>',
             'email_from': formataddr((self.partner_employee.name, self.partner_employee.email_normalized)),
             'is_internal': False,
             'message_type': 'comment',
             'model': test_record._name,
             'notified_partner_ids': self.partner_employee_2,
             'reply_to': formataddr(("%s %s" % (self.company_admin.name, test_record.name), '%s@%s' % (self.alias_catchall, self.alias_domain))),
             'res_id': test_record.id,
             'subtype_id': self.env.ref('mail.mt_comment'),
            }
        )
        self.assertEqual(test_record.message_partner_ids, self.partner_employee)

        test_record.message_subscribe(self.partner_1.ids)
        with self.assertSinglePostNotifications(
                [{'partner': self.partner_employee_2, 'type': 'inbox'},
                 {'partner': self.partner_1, 'type': 'email'}],
                message_info={'content': 'NewBody'},
                mail_unlink_sent=True
            ):
            new_message = test_record.message_post(
                body='NewBody',
                message_type='comment',
                subtype_xmlid='mail.mt_comment',
                partner_ids=[self.partner_employee_2.id],
            )

        self.assertMessageFields(
            new_message,
            {'notified_partner_ids': self.partner_1 + self.partner_employee_2}
        )
        # notifications emails should have been deleted
        self.assertFalse(self.env['mail.mail'].sudo().search_count([('mail_message_id', '=', new_message.id)]))

        with self.assertSinglePostNotifications(
                [{'partner': self.partner_1, 'type': 'email'},
                 {'partner': self.partner_portal, 'type': 'email'}],
                {'content': 'ToPortal'}
            ):
            test_record.message_post(
                body='ToPortal',
                message_type='comment',
                subtype_xmlid='mail.mt_comment',
                partner_ids=self.partner_portal.ids,
            )

    @users('employee')
    def test_message_post_inactive_follower(self):
        """ Test posting with inactive followers does not notify them (e.g. odoobot) """
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)
        test_record._message_subscribe(self.user_employee_2.partner_id.ids)
        self.user_employee_2.write({'active': False})
        self.partner_employee_2.write({'active': False})

        with self.assertPostNotifications([{'content': 'Test', 'notif': []}]):
            test_record.message_post(
                body='Test',
                message_type='comment',
                subtype_xmlid='mail.mt_comment',
            )

    @mute_logger('odoo.addons.mail.models.mail_mail')
    @users('employee')
    def test_message_post_keep_emails(self):
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)
        test_record.message_subscribe(partner_ids=self.partner_employee_2.ids)

        with self.mock_mail_gateway(mail_unlink_sent=True):
            msg = test_record.message_post(
                body='Test',
                mail_auto_delete=False,
                message_type='comment',
                partner_ids=[self.partner_1.id, self.partner_2.id],
                subject='Test',
                subtype_xmlid='mail.mt_comment',
            )

        # notifications emails should not have been deleted: one for customers, one for user
        self.assertEqual(self.env['mail.mail'].sudo().search_count([('mail_message_id', '=', msg.id)]), 2)

    @mute_logger('odoo.addons.mail.models.mail_mail')
    @users('employee')
    def test_message_post_w_attachments(self):
        _attachments = [
            ('List1', b'My first attachment'),
            ('List2', b'My second attachment'),
        ]
        _attachment_records = self.env['ir.attachment'].create(
            self._generate_attachments_data(3, res_id=0, res_model='mail.compose.message')
        )
        _attachment_records[1].write({'mimetype': 'image/png'})  # to test message_main_attachment heuristic

        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)
        self.assertFalse(test_record.message_main_attachment_id)

        with self.mock_mail_gateway():
            msg = test_record.message_post(
                attachments=_attachments,
                attachment_ids=_attachment_records.ids,
                body='Test',
                message_type='comment',
                partner_ids=[self.partner_1.id],
                subject='Test',
                subtype_xmlid='mail.mt_comment',
            )

        # updated message main attachment
        self.assertEqual(test_record.message_main_attachment_id, _attachment_records[1],
                         'MailThread: main attachment should be set to image/png')

        # message attachments
        self.assertEqual(len(msg.attachment_ids), 5)
        self.assertEqual(set(msg.attachment_ids.mapped('res_model')), set([self.test_record._name]))
        self.assertEqual(set(msg.attachment_ids.mapped('res_id')), set([self.test_record.id]))
        self.assertEqual(set(base64.b64decode(x) for x in msg.attachment_ids.mapped('datas')),
                         set([b'AttContent_00', b'AttContent_01', b'AttContent_02', _attachments[0][1], _attachments[1][1]]))
        self.assertTrue(set(_attachment_records.ids).issubset(msg.attachment_ids.ids),
                        'message_post: mail.message attachments duplicated')

        # notification email attachments
        self.assertEqual(len(self._mails), 1)
        self.assertSentEmail(
            self.user_employee.partner_id, [self.partner_1],
            attachments=[('List1', b'My first attachment', 'application/octet-stream'),
                         ('List2', b'My second attachment', 'application/octet-stream'),
                         ('AttFileName_00.txt', b'AttContent_00', 'text/plain'),
                         ('AttFileName_01.txt', b'AttContent_01', 'image/png'),
                         ('AttFileName_02.txt', b'AttContent_02', 'text/plain'),
                        ]
        )

    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_multiline_subject(self):
        with self.mock_mail_gateway():
            msg = self.test_record.with_user(self.user_employee).message_post(
                body='<p>Test Body</p>',
                partner_ids=[self.partner_1.id, self.partner_2.id],
                subject='1st line\n2nd line',
            )
        self.assertEqual(msg.subject, '1st line 2nd line')

    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_portal_acls(self):
        self.test_record.message_subscribe((self.partner_1 | self.user_employee.partner_id).ids)

        with self.assertPostNotifications(
                [{'content': '<p>Test</p>', 'notif': [
                    {'partner': self.partner_employee, 'type': 'inbox'},
                    {'partner': self.partner_1, 'type': 'email'}]}
                ]
            ), patch.object(MailTestSimple, 'check_access_rights', return_value=True):
            new_msg = self.test_record.with_user(self.user_portal).message_post(
                body='<p>Test</p>',
                message_type='comment',
                subject='Subject',
                subtype_xmlid='mail.mt_comment',
            )
        self.assertEqual(new_msg.sudo().notified_partner_ids, (self.partner_1 | self.user_employee.partner_id))

        with self.assertRaises(AccessError):
            self.test_record.with_user(self.user_portal).message_post(
                body='<p>Test</p>',
                message_type='comment',
                subject='Subject',
                subtype_xmlid='mail.mt_comment',
            )

    @mute_logger('odoo.addons.mail.models.mail_mail')
    @users('employee')
    def test_post_answer(self):
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)

        with self.mock_mail_gateway():
            parent_msg = test_record.message_post(
                body='<p>Test</p>',
                message_type='comment',
                subject='Test Subject',
                subtype_xmlid='mail.mt_comment',
            )
        self.assertFalse(parent_msg.partner_ids)
        self.assertNotSentEmail()

        # post a first reply
        with self.assertPostNotifications(
                [{'content': '<p>Test Answer</p>', 'notif': [{'partner': self.partner_1, 'type': 'email'}]}]
            ):
            msg = test_record.message_post(
                body='<p>Test Answer</p>',
                message_type='comment',
                parent_id=parent_msg.id,
                partner_ids=[self.partner_1.id],
                subject='Welcome',
                subtype_xmlid='mail.mt_comment',
            )
        self.assertEqual(msg.parent_id, parent_msg)
        self.assertEqual(msg.partner_ids, self.partner_1)
        self.assertFalse(parent_msg.partner_ids)

        # check notification emails: references
        self.assertSentEmail(
            self.user_employee.partner_id,
            [self.partner_1],
            references_content='openerp-%d-mail.test.simple' % self.test_record.id,
            # references should be sorted from the oldest to the newest
            references='%s %s' % (parent_msg.message_id, msg.message_id),
        )

        # post a reply to the reply: check parent is the first one
        with self.mock_mail_gateway():
            new_msg = test_record.message_post(
                body='<p>Test Answer Bis</p>',
                message_type='comment',
                subtype_xmlid='mail.mt_comment',
                parent_id=msg.id,
                partner_ids=[self.partner_2.id],
            )
        self.assertEqual(new_msg.parent_id, parent_msg, 'message_post: flatten error')
        self.assertEqual(new_msg.partner_ids, self.partner_2)
        self.assertSentEmail(
            self.user_employee.partner_id,
            [self.partner_2],
            body_content='<p>Test Answer Bis</p>',
            reply_to=msg.reply_to,
            subject='Re: %s' % self.test_record.name,
            references_content='openerp-%d-mail.test.simple' % self.test_record.id,
            references='%s %s' % (parent_msg.message_id, new_msg.message_id),
        )

    @mute_logger('odoo.addons.mail.models.mail_mail', 'odoo.addons.mail.models.mail_thread')
    @users('employee')
    def test_post_internal(self):
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)

        test_record.message_subscribe([self.user_admin.partner_id.id])
        with self.mock_mail_gateway():
            msg = test_record.message_post(
                body='My Body',
                message_type='comment',
                subject='My Subject',
                subtype_xmlid='mail.mt_note',
            )
        self.assertFalse(msg.is_internal,
                         'Notes are not "internal" but replies will be. Subtype being internal should be sufficient from ACLs point of view.')
        self.assertFalse(msg.partner_ids)
        self.assertFalse(msg.notified_partner_ids)

        self.format_and_process(
            MAIL_TEMPLATE_PLAINTEXT, self.user_admin.email, 'not_my_businesss@example.com',
            msg_id='<1198923581.41972151344608186800.JavaMail.diff1@agrolait.example.com>',
            extra='In-Reply-To:\r\n\t%s\n' % msg.message_id,
            target_model='mail.test.simple')
        reply = test_record.message_ids - msg
        self.assertTrue(reply)
        self.assertTrue(reply.is_internal)
        self.assertEqual(reply.notified_partner_ids, self.user_employee.partner_id)
        self.assertEqual(reply.parent_id, msg)
        self.assertEqual(reply.subtype_id, self.env.ref('mail.mt_note'))


@tagged('mail_post')
class TestMessagePostHelpers(TestMessagePostCommon):

    @classmethod
    def setUpClass(cls):
        super(TestMessagePostHelpers, cls).setUpClass()
        # ensure employee can create partners, necessary for templates
        cls.user_employee.write({
            'groups_id': [(4, cls.env.ref('base.group_partner_manager').id)],
        })

    @users('employee')
    def test_message_log_with_view(self):
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)
        new_note = test_record._message_log_with_view(
            'test_mail.mail_template_simple_test',
            values={'partner': self.user_employee.partner_id}
        )
        self.assertMessageFields(
            new_note,
            {'author_id': self.partner_employee,
             'body': '<p>Hello %s,</p>' % self.user_employee.name,
             'email_from': formataddr((self.partner_employee.name, self.partner_employee.email_normalized)),
             'is_internal': True,
             'message_type': 'notification',
             'model': test_record._name,
             'notified_partner_ids': self.env['res.partner'],
             'reply_to': formataddr((self.company_admin.name, '%s@%s' % (self.alias_catchall, self.alias_domain))),
             'res_id': test_record.id,
             'subtype_id': self.env.ref('mail.mt_note'),
            }
        )

    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_message_post_w_template(self):
        test_record = self.env['mail.test.simple'].with_context(self._test_context).create({'name': 'Test', 'email_from': 'ignasse@example.com'})

        _attachments = self._generate_attachments_data(count=2, res_id=0, res_model='mail.template')
        email_1 = 'test1@example.com'
        email_2 = 'test2@example.com'
        email_3 = self.partner_1.email
        template = self._create_template('mail.test.simple', {
            'attachment_ids': [(0, 0, attach_vals) for attach_vals in _attachments],
            'partner_to': '%s,%s' % (self.partner_2.id, self.user_admin.partner_id.id),
            'email_to': '%s, %s' % (email_1, email_2),
            'email_cc': '%s' % email_3,
        })
        template.attachment_ids.write({'res_id': template.id})

        # admin should receive emails
        self.user_admin.write({'notification_type': 'email'})
        # Force the attachments of the template to be in the natural order.
        self.email_template.invalidate_recordset(['attachment_ids'])

        with self.mock_mail_gateway():
            test_record.with_user(self.user_employee).message_post_with_template(self.email_template.id, composition_mode='comment')

        new_partners = self.env['res.partner'].search([('email', 'in', [email_1, email_2])])
        for r in [self.partner_1, self.partner_2, new_partners[0], new_partners[1], self.partner_admin]:
            self.assertSentEmail(
                self.user_employee.partner_id,
                [r],
                subject='About %s' % test_record.name,
                body_content=test_record.name,
                attachments=[
                    ('AttFileName_00.txt', b'AttContent_00', 'text/plain'),
                    ('AttFileName_01.txt', b'AttContent_01', 'text/plain'),
                ]
            )

    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_message_post_w_template_mass_mode(self):
        test_record = self.env['mail.test.simple'].with_context(self._test_context).create({'name': 'Test', 'email_from': 'ignasse@example.com'})
        self.user_employee.write({
            'groups_id': [(4, self.env.ref('base.group_partner_manager').id)],
        })

        _attachments = self._generate_attachments_data(count=2, res_id=0, res_model='mail.template')
        template = self._create_template('mail.test.simple', {
            'attachment_ids': [(0, 0, attach_vals) for attach_vals in _attachments],
            # After the HTML sanitizer, it will become "<p>Body for: <t t-out="object.name" /><a href="">link</a></p>"
            'body_html': 'Body for: <t t-out="object.name" /><script>test</script><a href="javascript:alert(1)">link</a>',
            'email_to': 'test@example.com',
            'email_cc': self.partner_1.email,
            'partner_to': '%s,%s' % (self.partner_2.id, self.user_admin.partner_id.id),
        })
        template.attachment_ids.write({'res_id': template.id})

        with self.mock_mail_gateway():
            test_record.with_user(self.user_employee).message_post_with_template(
                template.id,
                composition_mode='mass_mail'
            )

        new_partner = self.env['res.partner'].search([('email', '=', 'test@example.com')])

        self.assertSentEmail(
            self.user_employee.partner_id,
            [new_partner],
            subject='About %s' % test_record.name,
            body_content=test_record.name,
            attachments=[
                ('AttFileName_00.txt', b'AttContent_00', 'text/plain'),
                ('AttFileName_01.txt', b'AttContent_01', 'text/plain'),
            ]
        )


@tagged('mail_post', 'post_install', '-at_install')
class TestMessagePostGlobal(TestMessagePostCommon):

    @users('employee')
    def test_message_post_return(self):
        """ Ensures calling message_post through RPC always return an ID. """
        test_record = self.env['mail.test.simple'].browse(self.test_record.ids)

        # Use call_kw as shortcut to simulate a RPC call.
        message_id = call_kw(self.env['mail.test.simple'],
                             'message_post',
                             [test_record.id],
                             {'body': 'test'})
        self.assertTrue(isinstance(message_id, int))


@tagged('mail_post', 'multi_lang')
class TestMessagePostLang(TestMailCommon, TestRecipients):

    @classmethod
    def setUpClass(cls):
        super(TestMessagePostLang, cls).setUpClass()

        cls.test_records = cls.env['mail.test.lang'].create([
            {'customer_id': False,
             'email_from': 'test.record.1@test.customer.com',
             'lang': 'es_ES',
             'name': 'TestRecord1',
            },
            {'customer_id': cls.partner_2.id,
             'email_from': 'valid.other@gmail.com',
             'name': 'TestRecord2',
            },
        ])

        cls.test_template = cls.env['mail.template'].create({
            'auto_delete': True,
            'body_html': '<p>EnglishBody for <t t-out="object.name"/></p>',
            'email_from': '{{ user.email_formatted }}',
            'email_to': '{{ (object.email_from if not object.customer_id else "") }}',
            'lang': '{{ object.customer_id.lang or object.lang }}',
            'model_id': cls.env['ir.model']._get('mail.test.lang').id,
            'name': 'TestTemplate',
            'partner_to': '{{ object.customer_id.id if object.customer_id else "" }}',
            'subject': 'EnglishSubject for {{ object.name }}',
        })
        cls.user_employee.write({  # add group to create contacts, necessary for templates
            'groups_id': [(4, cls.env.ref('base.group_partner_manager').id)],
        })

        cls._activate_multi_company()
        cls._activate_multi_lang(test_record=cls.test_records[0], test_template=cls.test_template)

        cls.partner_2.write({'lang': 'es_ES'})

    @users('employee')
    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_composer_lang_template(self):
        test_records = self.test_records.with_user(self.env.user)
        test_template = self.test_template.with_user(self.env.user)

        with self.mock_mail_gateway():
            test_records.message_post_with_template(
                test_template.id,
                composition_mode='mass_mail',
                # email_layout_xmlid='mail.test_layout',  Not supported
                message_type='comment',
                subtype_id=self.env.ref('mail.mt_comment').id,
            )

        record0_customer = self.env['res.partner'].search([('email_normalized', '=', 'test.record.1@test.customer.com')], limit=1)
        self.assertTrue(record0_customer, 'Template usage should have created a contact based on record email')

        for record, customer in zip(test_records, record0_customer + self.partner_2):
            customer_email = self._find_sent_mail_wemail(customer.email_formatted)
            self.assertTrue(customer_email)
            body = customer_email['body']
            # check content
            # self.assertIn('SpanishBody for %s' % record.name, body, 'Body based on template should be translated')
            self.assertIn('EnglishBody for %s' % record.name, body, 'Fixme: this should be translated')
            # check subject
            # self.assertEqual('SpanishSubject for %s' % record.name, customer_email['subject'], 'Subject based on template should be translated')
            self.assertEqual('EnglishSubject for %s' % record.name, customer_email['subject'], 'Fixme: this should be translated')

    @users('employee')
    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_layout_email_lang_context(self):
        test_records = self.test_records.with_user(self.env.user).with_context(lang='es_ES')
        test_records[1].message_subscribe(self.partner_2.ids)

        with self.mock_mail_gateway():
            test_records[1].message_post(
                body='<p>Hello</p>',
                email_layout_xmlid='mail.test_layout',
                message_type='comment',
                subject='Subject',
                subtype_xmlid='mail.mt_comment',
            )

        customer_email = self._find_sent_mail_wemail(self.partner_2.email_formatted)
        self.assertTrue(customer_email)
        body = customer_email['body']
        # check notification layout translation
        self.assertIn('Spanish Layout para', body, 'Layout content should be translated')
        self.assertNotIn('English Layout for', body)
        self.assertIn('Spanish Layout para Spanish description', body, 'Model name should be translated')
        self.assertIn('SpanishView Spanish description', body, '"View document" should be translated')
        self.assertNotIn('View %s' % test_records[1]._description, body)
        self.assertIn('TestSpanishStuff', body, 'Groups-based action names should be translated')
        self.assertNotIn('TestStuff', body)
        # check content
        self.assertIn('Hello', body, 'Body of posted message should be present')

    @users('employee')
    @mute_logger('odoo.addons.mail.models.mail_mail')
    def test_layout_email_lang_template(self):
        test_records = self.test_records.with_user(self.env.user)
        test_template = self.test_template.with_user(self.env.user)

        with self.mock_mail_gateway():
            for test_record in test_records:
                test_record.message_post_with_template(
                    test_template.id,
                    email_layout_xmlid='mail.test_layout',
                    message_type='comment',
                    subtype_id=self.env.ref('mail.mt_comment').id,
                )

        record0_customer = self.env['res.partner'].search([('email_normalized', '=', 'test.record.1@test.customer.com')], limit=1)
        self.assertTrue(record0_customer, 'Template usage should have created a contact based on record email')

        for record, customer in zip(test_records, record0_customer + self.partner_2):
            customer_email = self._find_sent_mail_wemail(customer.email_formatted)
            self.assertTrue(customer_email)
            body = customer_email['body']
            # check notification layout translation
            self.assertIn('Spanish Layout para', body, 'Layout content should be translated')
            self.assertNotIn('English Layout for', body)
            self.assertIn('Spanish Layout para Spanish description', body, 'Model name should be translated')
            # self.assertIn('SpanishView Spanish description', body, '"View document" should be translated')
            self.assertIn('View %s' % test_records[1]._description, body, 'Fixme: this should be translated')
            # self.assertIn('TestSpanishStuff', body, 'Groups-based action names should be translated')
            self.assertIn('TestStuff', body, 'Fixme: groups-based action names should be translated')
            # check content
            self.assertIn('SpanishBody for %s' % record.name, body, 'Body based on template should be translated')
            # check subject
            self.assertEqual('SpanishSubject for %s' % record.name, customer_email['subject'], 'Subject based on template should be translated')
