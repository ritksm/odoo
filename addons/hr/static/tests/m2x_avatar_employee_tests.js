/** @odoo-module **/

import {
    afterNextRender,
    start,
    startServer,
} from '@mail/../tests/helpers/test_utils';

import FormView from 'web.FormView';
import KanbanView from 'web.KanbanView';
import ListView from 'web.ListView';
import { Many2OneAvatarEmployee } from '@hr/js/m2x_avatar_employee';
import { dom, mock } from 'web.test_utils';

QUnit.module('hr', {}, function () {
    QUnit.module('M2XAvatarEmployee', {
        beforeEach() {
            Many2OneAvatarEmployee.prototype.partnerIds = {};
        },
    });

    QUnit.test('many2one_avatar_employee widget in list view', async function (assert) {
        assert.expect(13);

        const pyEnv = await startServer();
        const [resPartnerId1, resPartnerId2] = pyEnv['res.partner'].create([
            { display_name: "Mario" },
            { display_name: "Luigi" },
        ]);
        const [resUsersId1, resUsersId2] = pyEnv['res.users'].create([
            { partner_id: resPartnerId1 },
            { partner_id: resPartnerId2 },
        ]);
        const [hrEmployeePublicId1, hrEmployeePublicId2] = pyEnv['hr.employee.public'].create([
            { name: "Mario", user_id: resUsersId1, user_partner_id: resPartnerId1 },
            { name: "Luigi", user_id: resUsersId2, user_partner_id: resPartnerId2 },
        ]);
        pyEnv['m2x.avatar.employee'].create([
            { employee_id: hrEmployeePublicId1, employee_ids: [hrEmployeePublicId1, hrEmployeePublicId2] },
            { employee_id: hrEmployeePublicId2 },
            { employee_id: hrEmployeePublicId1 },
        ]);
        await start({
            hasView: true,
            View: ListView,
            model: 'm2x.avatar.employee',
            arch: '<tree><field name="employee_id" widget="many2one_avatar_employee"/></tree>',
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
        });

        assert.strictEqual(document.querySelector('.o_data_cell span').innerText, 'Mario');
        assert.strictEqual(document.querySelectorAll('.o_data_cell span')[1].innerText, 'Luigi');
        assert.strictEqual(document.querySelectorAll('.o_data_cell span')[2].innerText, 'Mario');

        // click on first employee
        await afterNextRender(() =>
            dom.click(document.querySelector('.o_data_cell .o_m2o_avatar > img'))
        );
        assert.verifySteps(
            [`read hr.employee.public ${hrEmployeePublicId1}`],
            "first employee should have been read to find its partner"
        );
        assert.containsOnce(
            document.body,
            '.o_ChatWindowHeader_name',
            'should have opened chat window'
        );
        assert.strictEqual(
            document.querySelector('.o_ChatWindowHeader_name').textContent,
            "Mario",
            'chat window should be with clicked employee'
        );

        // click on second employee
        await afterNextRender(() =>
            dom.click(document.querySelectorAll('.o_data_cell .o_m2o_avatar > img')[1]
        ));
        assert.verifySteps(
            [`read hr.employee.public ${hrEmployeePublicId2}`],
            "second employee should have been read to find its partner"
        );
        assert.containsN(
            document.body,
            '.o_ChatWindowHeader_name',
            2,
            'should have opened second chat window'
        );
        assert.strictEqual(
            document.querySelectorAll('.o_ChatWindowHeader_name')[1].textContent,
            "Luigi",
            'chat window should be with clicked employee'
        );

        // click on third employee (same as first)
        await afterNextRender(() =>
            dom.click(document.querySelectorAll('.o_data_cell .o_m2o_avatar > img')[2])
        );
        assert.verifySteps(
            [],
            "employee should not have been read again because we already know its partner"
        );
        assert.containsN(
            document.body,
            '.o_ChatWindowHeader_name',
            2,
            "should still have only 2 chat windows because third is the same partner as first"
        );
    });

    QUnit.test('many2one_avatar_employee widget in kanban view', async function (assert) {
        assert.expect(3);

        const pyEnv = await startServer();
        const resPartnerId1 = pyEnv['res.partner'].create();
        const resUsersId1 = pyEnv['res.users'].create({ partner_id: resPartnerId1 });
        const hrEmployeePublicId1 = pyEnv['hr.employee.public'].create({ user_id: resUsersId1, user_partner_id: resPartnerId1 });
        pyEnv['m2x.avatar.employee'].create({ employee_id: hrEmployeePublicId1, employee_ids: [hrEmployeePublicId1] });
        await start({
            hasView: true,
            View: KanbanView,
            model: 'm2x.avatar.employee',
            data: this.data,
            arch: `
                <kanban>
                    <templates>
                        <t t-name="kanban-box">
                            <div>
                                <field name="employee_id" widget="many2one_avatar_employee"/>
                            </div>
                        </t>
                    </templates>
                </kanban>`,
        });

        assert.strictEqual(document.querySelector('.o_kanban_record').innerText.trim(), '');
        assert.containsOnce(document.body, '.o_m2o_avatar');
        assert.strictEqual(document.querySelector('.o_m2o_avatar > img').getAttribute('data-src'), `/web/image/hr.employee.public/${hrEmployeePublicId1}/avatar_128`);
    });

    QUnit.test('many2one_avatar_employee: click on an employee not associated with a user', async function (assert) {
        assert.expect(6);

        const pyEnv = await startServer();
        const hrEmployeePublicId1 = pyEnv['hr.employee.public'].create({ name: 'Mario' });
        const m2xHrAvatarUserId1 = pyEnv['m2x.avatar.employee'].create({ employee_id: hrEmployeePublicId1 });
        const { widget } = await start({
            hasView: true,
            View: FormView,
            model: 'm2x.avatar.employee',
            data: this.data,
            arch: '<form><field name="employee_id" widget="many2one_avatar_employee"/></form>',
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
            res_id: m2xHrAvatarUserId1,
            services: {
                notification: {
                    notify(notification) {
                        assert.ok(
                            true,
                            "should display a toast notification after failing to open chat"
                        );
                        assert.strictEqual(
                            notification.message,
                            "You can only chat with employees that have a dedicated user.",
                            "should display the correct information in the notification"
                        );
                    },
                },
            },
        });
        mock.intercept(widget, 'call_service', (ev) => {
            if (ev.data.service === 'notification') {
                assert.step(`display notification "${ev.data.args[0].message}"`);
            }
        }, true);

        assert.strictEqual(document.querySelector('.o_field_widget[name=employee_id]').innerText.trim(), 'Mario');

        await dom.click(document.querySelector('.o_m2o_avatar > img'));

        assert.verifySteps([
            `read m2x.avatar.employee ${m2xHrAvatarUserId1}`,
            `read hr.employee.public ${hrEmployeePublicId1}`,
        ]);
    });

    QUnit.test('many2many_avatar_employee widget in form view', async function (assert) {
        assert.expect(8);

        const pyEnv = await startServer();
        const [resPartnerId1, resPartnerId2] = pyEnv['res.partner'].create([{}, {}]);
        const [resUsersId1, resUsersId2] = pyEnv['res.users'].create([{}, {}]);
        const [hrEmployeePublicId1, hrEmployeePublicId2] = pyEnv['hr.employee.public'].create([
            { user_id: resUsersId1, user_partner_id: resPartnerId1 },
            { user_id: resUsersId2, user_partner_id: resPartnerId2 },
        ]);
        const m2xAvatarEmployeeId1 = pyEnv['m2x.avatar.employee'].create(
            { employee_ids: [hrEmployeePublicId1, hrEmployeePublicId2] },
        );
        await start({
            hasView: true,
            View: FormView,
            model: 'm2x.avatar.employee',
            data: this.data,
            arch: '<form><field name="employee_ids" widget="many2many_avatar_employee"/></form>',
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
            res_id: m2xAvatarEmployeeId1,
        });

        assert.containsN(document.body, '.o_field_many2manytags.avatar.o_field_widget .badge', 2,
            "should have 2 records");
        assert.strictEqual(document.querySelector('.o_field_many2manytags.avatar.o_field_widget .badge img').getAttribute('data-src'),
            `/web/image/hr.employee.public/${hrEmployeePublicId1}/avatar_128`,
            "should have correct avatar image");

        await dom.click(document.querySelector('.o_field_many2manytags.avatar .badge .o_m2m_avatar'));
        await dom.click(document.querySelectorAll('.o_field_many2manytags.avatar .badge .o_m2m_avatar')[1]);

        assert.verifySteps([
            `read m2x.avatar.employee ${m2xAvatarEmployeeId1}`,
            `read hr.employee.public ${hrEmployeePublicId1},${hrEmployeePublicId2}`,
            `read hr.employee.public ${hrEmployeePublicId1}`,
            `read hr.employee.public ${hrEmployeePublicId2}`,
        ]);

        assert.containsN(
            document.body,
            '.o_ChatWindowHeader_name',
            2,
            "should have 2 chat windows"
        );
    });

    QUnit.test('many2many_avatar_employee widget in list view', async function (assert) {
        assert.expect(10);

        const pyEnv = await startServer();
        const [resPartnerId1, resPartnerId2] = pyEnv['res.partner'].create([
            { name: "Mario" },
            { name: "Yoshi" },
        ]);
        const [resUsersId1, resUsersId2] = pyEnv['res.users'].create([{}, {}]);
        const [hrEmployeePublicId1, hrEmployeePublicId2] = pyEnv['hr.employee.public'].create([
            { user_id: resUsersId1, user_partner_id: resPartnerId1 },
            { user_id: resUsersId2, user_partner_id: resPartnerId2 },
        ]);
        pyEnv['m2x.avatar.employee'].create(
            { employee_ids: [hrEmployeePublicId1, hrEmployeePublicId2] },
        );
        await start({
            hasView: true,
            View: ListView,
            model: 'm2x.avatar.employee',
            arch: '<tree><field name="employee_ids" widget="many2many_avatar_employee"/></tree>',
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
        });

        assert.containsN(document.body, '.o_data_cell:first .o_field_many2manytags > span', 2,
            "should have two avatar");

        // click on first employee badge
        await afterNextRender(() =>
            dom.click(document.querySelector('.o_data_cell .o_m2m_avatar'))
        );
        assert.verifySteps(
            [`read hr.employee.public ${hrEmployeePublicId1},${hrEmployeePublicId2}`, `read hr.employee.public ${hrEmployeePublicId1}`],
            "first employee should have been read to find its partner"
        );
        assert.containsOnce(
            document.body,
            '.o_ChatWindowHeader_name',
            'should have opened chat window'
        );
        assert.strictEqual(
            document.querySelector('.o_ChatWindowHeader_name').textContent,
            "Mario",
            'chat window should be with clicked employee'
        );

        // click on second employee
        await afterNextRender(() =>
            dom.click(document.querySelectorAll('.o_data_cell .o_m2m_avatar')[1])
        );
        assert.verifySteps(
            [`read hr.employee.public ${hrEmployeePublicId2}`],
            "second employee should have been read to find its partner"
        );
        assert.containsN(
            document.body,
            '.o_ChatWindowHeader_name',
            2,
            'should have opened second chat window'
        );
        assert.strictEqual(
            document.querySelectorAll('.o_ChatWindowHeader_name')[1].textContent,
            "Yoshi",
            'chat window should be with clicked employee'
        );
    });

    QUnit.test('many2many_avatar_employee widget in kanban view', async function (assert) {
        assert.expect(7);

        const pyEnv = await startServer();
        const [resPartnerId1, resPartnerId2] = pyEnv['res.partner'].create([{}, {}]);
        const [resUsersId1, resUsersId2] = pyEnv['res.users'].create([{}, {}]);
        const [hrEmployeePublicId1, hrEmployeePublicId2] = pyEnv['hr.employee.public'].create([
            { user_id: resUsersId1, user_partner_id: resPartnerId1 },
            { user_id: resUsersId2, user_partner_id: resPartnerId2 },
        ]);
        pyEnv['m2x.avatar.employee'].create(
            { employee_ids: [hrEmployeePublicId1, hrEmployeePublicId2] },
        );
        await start({
            hasView: true,
            View: KanbanView,
            model: 'm2x.avatar.employee',
            arch: `
                <kanban>
                    <templates>
                        <t t-name="kanban-box">
                            <div>
                                <div class="oe_kanban_footer">
                                    <div class="o_kanban_record_bottom">
                                        <div class="oe_kanban_bottom_right">
                                            <field name="employee_ids" widget="many2many_avatar_employee"/>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </t>
                    </templates>
                </kanban>`,
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
        });

        assert.containsN(document.body, '.o_kanban_record:first .o_field_many2manytags img.o_m2m_avatar', 2,
            "should have 2 avatar images");
        assert.strictEqual(document.querySelector('.o_kanban_record .o_field_many2manytags img.o_m2m_avatar').getAttribute('data-src'),
            `/web/image/hr.employee.public/${hrEmployeePublicId1}/avatar_128`,
            "should have correct avatar image");
        assert.strictEqual(document.querySelectorAll('.o_kanban_record .o_field_many2manytags img.o_m2m_avatar')[1].getAttribute('data-src'),
            `/web/image/hr.employee.public/${hrEmployeePublicId2}/avatar_128`,
            "should have correct avatar image");

        await dom.click(document.querySelector('.o_kanban_record .o_m2m_avatar'));
        await dom.click(document.querySelectorAll('.o_kanban_record .o_m2m_avatar')[1]);

        assert.verifySteps([
            `read hr.employee.public ${hrEmployeePublicId1},${hrEmployeePublicId2}`,
            `read hr.employee.public ${hrEmployeePublicId1}`,
            `read hr.employee.public ${hrEmployeePublicId2}`
        ]);
    });

    QUnit.test('many2many_avatar_employee: click on an employee not associated with a user', async function (assert) {
        assert.expect(10);

        const pyEnv = await startServer();
        const resPartnerId1 = pyEnv['res.partner'].create();
        const resUsersId1 = pyEnv['res.users'].create();
        const [hrEmployeePublicId1, hrEmployeePublicId2] = pyEnv['hr.employee.public'].create([
            {},
            { user_id: resUsersId1, user_partner_id: resPartnerId1 },
        ]);
        const m2xAvatarEmployeeId1 = pyEnv['m2x.avatar.employee'].create(
            { employee_ids: [hrEmployeePublicId1, hrEmployeePublicId2] },
        );
        const { widget } = await start({
            hasView: true,
            View: FormView,
            model: 'm2x.avatar.employee',
            arch: '<form><field name="employee_ids" widget="many2many_avatar_employee"/></form>',
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
            res_id: m2xAvatarEmployeeId1,
            services: {
                notification: {
                    notify(notification) {
                        assert.ok(
                            true,
                            "should display a toast notification after failing to open chat"
                        );
                        assert.strictEqual(
                            notification.message,
                            "You can only chat with employees that have a dedicated user.",
                            "should display the correct information in the notification"
                        );
                    },
                },
            },
        });

        mock.intercept(widget, 'call_service', (ev) => {
            if (ev.data.service === 'notification') {
                assert.step(`display notification "${ev.data.args[0].message}"`);
            }
        }, true);

        assert.containsN(document.body, '.o_field_many2manytags.avatar.o_field_widget .badge', 2,
            "should have 2 records");
        assert.strictEqual(document.querySelector('.o_field_many2manytags.avatar.o_field_widget .badge img').getAttribute('data-src'),
            `/web/image/hr.employee.public/${hrEmployeePublicId1}/avatar_128`,
            "should have correct avatar image");

        await dom.click(document.querySelector('.o_field_many2manytags.avatar .badge .o_m2m_avatar'));
        await dom.click(document.querySelectorAll('.o_field_many2manytags.avatar .badge .o_m2m_avatar')[1]);

        assert.verifySteps([
            `read m2x.avatar.employee ${hrEmployeePublicId1}`,
            `read hr.employee.public ${hrEmployeePublicId1},${hrEmployeePublicId2}`,
            `read hr.employee.public ${hrEmployeePublicId1}`,
            `read hr.employee.public ${hrEmployeePublicId2}`
        ]);

        assert.containsOnce(document.body, '.o_ChatWindowHeader_name',
            "should have 1 chat window");
    });
});
