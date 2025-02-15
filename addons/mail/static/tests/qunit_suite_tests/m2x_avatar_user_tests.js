/** @odoo-module **/

import { Many2OneAvatarUser } from '@mail/js/m2x_avatar_user';
import { start, startServer } from '@mail/../tests/helpers/test_utils';
import { click, getFixture, legacyExtraNextTick, patchWithCleanup, triggerHotkey } from "@web/../tests/helpers/utils";
import { doAction } from '@web/../tests/webclient/helpers';
import { registry } from "@web/core/registry";
import { makeLegacyCommandService } from "@web/legacy/utils";
import core from 'web.core';
import FormView from 'web.FormView';
import KanbanView from 'web.KanbanView';
import ListView from 'web.ListView';
import session from 'web.session';
import makeTestEnvironment from "web.test_env";
import { dom, nextTick } from 'web.test_utils';

let target;

QUnit.module('mail', {}, function () {
    QUnit.module('M2XAvatarUser', {
        beforeEach() {
            // reset the cache before each test
            Many2OneAvatarUser.prototype.partnerIds = {};
            target = getFixture();
        },
    });

    QUnit.test('many2one_avatar_user widget in list view', async function (assert) {
        assert.expect(2);

        const pyEnv = await startServer();
        const resPartnerId1 = pyEnv['res.partner'].create({ display_name: 'Partner 1' });
        const resUsersId1 = pyEnv['res.users'].create({ name: "Mario", partner_id: resPartnerId1 });
        pyEnv['m2x.avatar.user'].create({ user_id: resUsersId1 });
        const { widget: list } = await start({
            hasView: true,
            View: ListView,
            model: 'm2x.avatar.user',
            arch: '<tree><field name="user_id" widget="many2one_avatar_user"/></tree>',
        });

        await dom.click(list.$('.o_data_cell:nth(0) .o_m2o_avatar > img'));
        assert.containsOnce(document.body, '.o_ChatWindow', 'Chat window should be opened');
        assert.strictEqual(
            document.querySelector('.o_ChatWindowHeader_name').textContent,
            'Partner 1',
            'Chat window should be related to partner 1'
        );
    });

    QUnit.test('many2many_avatar_user widget in form view', async function (assert) {
        assert.expect(2);

        const pyEnv = await startServer();
        const resPartnerId1 = pyEnv['res.partner'].create({ display_name: 'Partner 1' });
        const resUsersId1 = pyEnv['res.users'].create({ name: "Mario", partner_id: resPartnerId1 });
        const m2xAvatarUserId1 = pyEnv['m2x.avatar.user'].create({ user_ids: [resUsersId1] });
        await start({
            hasView: true,
            View: FormView,
            model: 'm2x.avatar.user',
            arch: '<form><field name="user_ids" widget="many2many_avatar_user"/></form>',
            res_id: m2xAvatarUserId1,
        });

        await dom.click(document.querySelector('.o_field_many2manytags.avatar .badge .o_m2m_avatar'));
        assert.containsOnce(document.body, '.o_ChatWindow', 'Chat window should be opened');
        assert.strictEqual(
            document.querySelector('.o_ChatWindowHeader_name').textContent,
            'Partner 1',
            'First chat window should be related to partner 1'
        );
    });

    QUnit.test('many2many_avatar_user in kanban view', async function (assert) {
        assert.expect(5);

        const pyEnv = await startServer();
        const resUsersIds = pyEnv['res.users'].create(
            [{ name: "Mario" }, { name: "Yoshi" }, { name: "Luigi" }, { name: "Tapu" }],
        );
        pyEnv['m2x.avatar.user'].create({ user_ids: resUsersIds });

        await start({
            hasView: true,
            View: KanbanView,
            model: 'm2x.avatar.user',
            arch: `
                <kanban>
                    <templates>
                        <t t-name="kanban-box">
                            <div>
                                <field name="user_id"/>
                                <div class="oe_kanban_footer">
                                    <div class="o_kanban_record_bottom">
                                        <div class="oe_kanban_bottom_right">
                                            <field name="user_ids" widget="many2many_avatar_user"/>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </t>
                    </templates>
                </kanban>`,
        });

        assert.containsOnce(document.body, '.o_kanban_record .o_field_many2manytags .o_m2m_avatar_empty',
            "should have o_m2m_avatar_empty span");
        assert.strictEqual(document.querySelector('.o_kanban_record .o_field_many2manytags .o_m2m_avatar_empty').innerText.trim(), "+2",
            "should have +2 in o_m2m_avatar_empty");

        document.querySelector('.o_kanban_record .o_field_many2manytags .o_m2m_avatar_empty').dispatchEvent(new Event('mouseover'));
        await nextTick();
        assert.containsOnce(document.body, '.popover',
            "should open a popover hover on o_m2m_avatar_empty");
        assert.strictEqual(document.querySelector('.popover .popover-body > div').innerText.trim(), 'Luigi', 'should have a right text in popover');
        assert.strictEqual(document.querySelectorAll('.popover .popover-body > div')[1].innerText.trim(), 'Tapu', 'should have a right text in popover');
    });

    QUnit.test('many2one_avatar_user widget edited by the smart action "Assign to..."', async function (assert) {
        assert.expect(4);

        const pyEnv = await startServer();
        const [resUsersId1] = pyEnv['res.users'].create(
            [{ name: "Mario" }, { name: "Luigi" }, { name: "Yoshi" }],
        );
        const m2xAvatarUserId1 = pyEnv['m2x.avatar.user'].create({ user_id: resUsersId1 });
        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        const serviceRegistry = registry.category("services");
        serviceRegistry.add("legacy_command", makeLegacyCommandService(legacyEnv));

        const views = {
            'm2x.avatar.user,false,form': '<form><field name="user_id" widget="many2one_avatar_user"/></form>',
            'm2x.avatar.user,false,search': '<search></search>',
        };
        const { widget: webClient } = await start({ hasWebClient: true, serverData: { views } });
        await doAction(webClient, {
            res_id: m2xAvatarUserId1,
            type: 'ir.actions.act_window',
            target: 'current',
            res_model: 'm2x.avatar.user',
            'view_mode': 'form',
            'views': [[false, 'form']],
        });
        assert.strictEqual(target.querySelector(".o_m2o_avatar > span").textContent, "Mario")

        triggerHotkey("control+k")
        await nextTick();
        const idx = [...target.querySelectorAll(".o_command")].map(el => el.textContent).indexOf("Assign to ...ALT + I")
        assert.ok(idx >= 0);

        await click([...target.querySelectorAll(".o_command")][idx])
        await nextTick();
        assert.deepEqual([...target.querySelectorAll(".o_command")].map(el => el.textContent), [
            "Your Company, Mitchell Admin",
            "Public user",
            "Mario",
            "Luigi",
            "Yoshi",
          ])
        await click(target, "#o_command_3")
        await legacyExtraNextTick();
        assert.strictEqual(target.querySelector(".o_m2o_avatar > span").textContent, "Luigi")
    });

    QUnit.test('many2one_avatar_user widget edited by the smart action "Assign to me"', async function (assert) {
        assert.expect(4);

        const pyEnv = await startServer();
        const [resUsersId1, resUsersId2] = pyEnv['res.users'].create([{ name: "Mario" }, { name: "Luigi" }]);
        const m2xAvatarUserId1 = pyEnv['m2x.avatar.user'].create({ user_id: resUsersId1 });
        patchWithCleanup(session, { user_id: [resUsersId2] });
        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        const serviceRegistry = registry.category("services");
        serviceRegistry.add("legacy_command", makeLegacyCommandService(legacyEnv));

        const views = {
            'm2x.avatar.user,false,form': '<form><field name="user_id" widget="many2one_avatar_user"/></form>',
            'm2x.avatar.user,false,search': '<search></search>',
        };
        const { widget: webClient } = await start({ hasWebClient: true, serverData: { views } });
        await doAction(webClient, {
            res_id: m2xAvatarUserId1,
            type: 'ir.actions.act_window',
            target: 'current',
            res_model: 'm2x.avatar.user',
            'view_mode': 'form',
            'views': [[false, 'form']],
        });
        assert.strictEqual(target.querySelector(".o_m2o_avatar > span").textContent, "Mario")
        triggerHotkey("control+k")
        await nextTick();
        const idx = [...target.querySelectorAll(".o_command")].map(el => el.textContent).indexOf("Assign/unassign to meALT + SHIFT + I")
        assert.ok(idx >= 0);

        // Assign me (Luigi)
        triggerHotkey("alt+shift+i")
        await legacyExtraNextTick();
        assert.strictEqual(target.querySelector(".o_m2o_avatar > span").textContent, "Luigi")

        // Unassign me
        triggerHotkey("control+k");
        await nextTick();
        await click([...target.querySelectorAll(".o_command")][idx])
        await legacyExtraNextTick();
        assert.strictEqual(target.querySelector(".o_m2o_avatar > span").textContent, "")
    });

    QUnit.test('many2many_avatar_user widget edited by the smart action "Assign to..."', async function (assert) {
        assert.expect(4);

        const pyEnv = await startServer();
        const [resUsersId1, resUsersId2] = pyEnv['res.users'].create(
            [{ name: "Mario" }, { name: "Yoshi" }, { name: "Luigi" }],
        );
        const m2xAvatarUserId1 = pyEnv['m2x.avatar.user'].create({ user_ids: [resUsersId1, resUsersId2] });
        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        const serviceRegistry = registry.category("services");
        serviceRegistry.add("legacy_command", makeLegacyCommandService(legacyEnv));

        const views = {
            'm2x.avatar.user,false,form': '<form><field name="user_ids" widget="many2many_avatar_user"/></form>',
            'm2x.avatar.user,false,search': '<search></search>',
        };
        const { widget: webClient } = await start({ hasWebClient: true, serverData: { views } });
        await doAction(webClient, {
            res_id: m2xAvatarUserId1,
            type: 'ir.actions.act_window',
            target: 'current',
            res_model: 'm2x.avatar.user',
            'view_mode': 'form',
            'views': [[false, 'form']],
        });
        let userNames = [...target.querySelectorAll(".o_tag_badge_text")].map((el => el.textContent));
        assert.deepEqual(userNames, ["Mario", "Yoshi"]);

        triggerHotkey("control+k")
        await nextTick();
        const idx = [...target.querySelectorAll(".o_command")].map(el => el.textContent).indexOf("Assign to ...ALT + I")
        assert.ok(idx >= 0);

        await click([...target.querySelectorAll(".o_command")][idx])
        await nextTick();
        assert.deepEqual([...target.querySelectorAll(".o_command")].map(el => el.textContent), [
            "Your Company, Mitchell Admin",
            "Public user",
            "Luigi"
          ]);

        await click(target, "#o_command_2");
        await legacyExtraNextTick();
        userNames = [...target.querySelectorAll(".o_tag_badge_text")].map(el => el.textContent);
        assert.deepEqual(userNames, ["Mario", "Yoshi", "Luigi"]);
    });

    QUnit.test('many2many_avatar_user widget edited by the smart action "Assign to me"', async function (assert) {
        assert.expect(4);

        const pyEnv = await startServer();
        const [resUsersId1, resUsersId2, resUsersId3] = pyEnv['res.users'].create(
            [{ name: "Mario" }, { name: "Luigi" }, { name: "Yoshi" }],
        );
        const m2xAvatarUserId1 = pyEnv['m2x.avatar.user'].create({ user_ids: [resUsersId1, resUsersId3] });
        patchWithCleanup(session, { user_id: [resUsersId2] });
        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        const serviceRegistry = registry.category("services");
        serviceRegistry.add("legacy_command", makeLegacyCommandService(legacyEnv));

        const views = {
            'm2x.avatar.user,false,form': '<form><field name="user_ids" widget="many2many_avatar_user"/></form>',
            'm2x.avatar.user,false,search': '<search></search>',
        };
        const { widget: webClient } = await start({ hasWebClient: true, serverData: { views } });
        await doAction(webClient, {
            res_id: m2xAvatarUserId1,
            type: 'ir.actions.act_window',
            target: 'current',
            res_model: 'm2x.avatar.user',
            'view_mode': 'form',
            'views': [[false, 'form']],
        });
        let userNames = [...target.querySelectorAll(".o_tag_badge_text")].map((el => el.textContent));
        assert.deepEqual(userNames, ["Mario", "Yoshi"]);

        triggerHotkey("control+k");
        await nextTick();
        const idx = [...target.querySelectorAll(".o_command")].map(el => el.textContent).indexOf("Assign/unassign to meALT + SHIFT + I");
        assert.ok(idx >= 0);

        // Assign me (Luigi)
        triggerHotkey("alt+shift+i");
        await legacyExtraNextTick();
        userNames = [...target.querySelectorAll(".o_tag_badge_text")].map((el => el.textContent));
        assert.deepEqual(userNames, ["Mario", "Yoshi", "Luigi"]);

        // Unassign me
        triggerHotkey("control+k");
        await nextTick();
        await click([...target.querySelectorAll(".o_command")][idx]);
        await legacyExtraNextTick();
        userNames = [...target.querySelectorAll(".o_tag_badge_text")].map((el => el.textContent));
        assert.deepEqual(userNames, ["Mario", "Yoshi"]);
    });

    QUnit.test('avatar_user widget displays the appropriate user image in list view', async function (assert) {
        assert.expect(1);

        const pyEnv = await startServer();
        const resUsersId1 = pyEnv['res.users'].create({ name: "Mario" });
        const m2xAvatarUserId1 = pyEnv['m2x.avatar.user'].create({ user_id: resUsersId1 });
        await start({
            hasView: true,
            View: ListView,
            model: 'm2x.avatar.user',
            arch: '<tree><field name="user_id" widget="many2one_avatar_user"/></tree>',
            res_id: m2xAvatarUserId1,
        });
        assert.strictEqual(
            document.querySelector('.o_m2o_avatar > img').getAttribute('data-src'),
            `/web/image/res.users/${resUsersId1}/avatar_128`,
            'Should have correct avatar image'
        );
    });

    QUnit.test('avatar_user widget displays the appropriate user image in kanban view', async function (assert) {
        assert.expect(1);

        const pyEnv = await startServer();
        const resUsersId1 = pyEnv['res.users'].create({ name: "Mario" });
        const m2xAvatarUserId1 = pyEnv['m2x.avatar.user'].create({ user_id: resUsersId1 });
        await start({
            hasView: true,
            View: KanbanView,
            model: 'm2x.avatar.user',
            arch: `<kanban>
                        <templates>
                            <t t-name="kanban-box">
                                <div>
                                    <field name="user_id" widget="many2one_avatar_user"/>
                                </div>
                            </t>
                        </templates>
                    </kanban>`,
            res_id: m2xAvatarUserId1,
        });
        assert.strictEqual(
            document.querySelector('.o_m2o_avatar > img').getAttribute('data-src'),
            `/web/image/res.users/${resUsersId1}/avatar_128`,
            'Should have correct avatar image'
        );
    });

    QUnit.test('avatar_user widget displays the appropriate user image in form view', async function (assert) {
        assert.expect(1);

        const pyEnv = await startServer();
        const resUsersId1 = pyEnv['res.users'].create({ name: "Mario" });
        const m2xAvatarUserId1 = pyEnv['m2x.avatar.user'].create({ user_ids: [resUsersId1] });
        await start({
            hasView: true,
            View: FormView,
            model: 'm2x.avatar.user',
            arch: '<form><field name="user_ids" widget="many2many_avatar_user"/></form>',
            res_id: m2xAvatarUserId1,
        });
        assert.strictEqual(
            document.querySelector('.o_field_many2manytags.avatar.o_field_widget .badge img').getAttribute('data-src'),
            `/web/image/res.users/${resUsersId1}/avatar_128`,
            'Should have correct avatar image'
        );
    });
});
