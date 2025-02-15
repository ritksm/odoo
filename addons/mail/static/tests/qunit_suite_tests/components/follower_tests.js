/** @odoo-module **/

import { makeDeferred } from '@mail/utils/deferred';
import { start, startServer } from '@mail/../tests/helpers/test_utils';

import Bus from 'web.Bus';

QUnit.module('mail', {}, function () {
QUnit.module('components', {}, function () {
QUnit.module('follower_tests.js');

QUnit.test('base rendering not editable', async function (assert) {
    assert.expect(5);

    const pyEnv = await startServer();
    const [threadId, partnerId] = pyEnv['res.partner'].create([{}, {}]);
    pyEnv['mail.followers'].create({
        is_active: true,
        partner_id: partnerId,
        res_id: threadId,
        res_model: 'res.partner',
    });
    const { click, createChatterContainerComponent } = await start({
        async mockRPC(route, args) {
            if (route === '/mail/thread/data') {
                // mimic user without write access
                const res = await this._super(...arguments);
                res['hasWriteAccess'] = false;
                return res;
            }
            return this._super(...arguments);
        },
    });
    await createChatterContainerComponent({
        threadId,
        threadModel: 'res.partner',
    });
    await click('.o_FollowerListMenu_buttonFollowers');
    assert.containsOnce(
        document.body,
        '.o_Follower',
        "should have follower component"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_details',
        "should display a details part"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_avatar',
        "should display the avatar of the follower"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_name',
        "should display the name of the follower"
    );
    assert.containsNone(
        document.body,
        '.o_Follower_button',
        "should have no button as follower is not editable"
    );
});

QUnit.test('base rendering editable', async function (assert) {
    assert.expect(6);

    const pyEnv = await startServer();
    const [threadId, partnerId] = pyEnv['res.partner'].create([{}, {}]);
    pyEnv['mail.followers'].create({
        is_active: true,
        partner_id: partnerId,
        res_id: threadId,
        res_model: 'res.partner',
    });
    const { click, createChatterContainerComponent } = await start();
    await createChatterContainerComponent({
        threadId,
        threadModel: 'res.partner',
    });
    await click('.o_FollowerListMenu_buttonFollowers');
    assert.containsOnce(
        document.body,
        '.o_Follower',
        "should have follower component"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_details',
        "should display a details part"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_avatar',
        "should display the avatar of the follower"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_name',
        "should display the name of the follower"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_editButton',
        "should have an edit button"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_removeButton',
        "should have a remove button"
    );
});

QUnit.test('click on partner follower details', async function (assert) {
    assert.expect(7);

    const pyEnv = await startServer();
    const [threadId, partnerId] = pyEnv['res.partner'].create([{}, {}]);
    pyEnv['mail.followers'].create({
        is_active: true,
        partner_id: partnerId,
        res_id: threadId,
        res_model: 'res.partner',
    });
    const openFormDef = makeDeferred();
    const bus = new Bus();
    bus.on('do-action', null, ({ action }) => {
            assert.step('do_action');
            assert.strictEqual(
                action.res_id,
                partnerId,
                "The redirect action should redirect to the right res id (partnerId)"
            );
            assert.strictEqual(
                action.res_model,
                'res.partner',
                "The redirect action should redirect to the right res model (res.partner)"
            );
            assert.strictEqual(
                action.type,
                "ir.actions.act_window",
                "The redirect action should be of type 'ir.actions.act_window'"
            );
            openFormDef.resolve();
    });
    const { click, createChatterContainerComponent } = await start({ env: { bus } });
    await createChatterContainerComponent({
        threadId,
        threadModel: 'res.partner',
    });
    await click('.o_FollowerListMenu_buttonFollowers');
    assert.containsOnce(
        document.body,
        '.o_Follower',
        "should have follower component"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_details',
        "should display a details part"
    );

    document.querySelector('.o_Follower_details').click();
    await openFormDef;
    assert.verifySteps(
        ['do_action'],
        "clicking on follower should redirect to partner form view"
    );
});

QUnit.test('click on edit follower', async function (assert) {
    assert.expect(5);

    const pyEnv = await startServer();
    const [threadId, partnerId] = pyEnv['res.partner'].create([{}, {}]);
    pyEnv['mail.followers'].create({
        is_active: true,
        partner_id: partnerId,
        res_id: threadId,
        res_model: 'res.partner',
    });
    const { click, createChatterContainerComponent, messaging } = await start({
        async mockRPC(route, args) {
            if (route.includes('/mail/read_subscription_data')) {
                assert.step('fetch_subtypes');
            }
            return this._super(...arguments);
        },
    });
    const thread = messaging.models['Thread'].create({
        id: threadId,
        model: 'res.partner',
    });
    await thread.fetchData(['followers']);
    await createChatterContainerComponent({
        threadId,
        threadModel: 'res.partner',
    });
    await click('.o_FollowerListMenu_buttonFollowers');
    assert.containsOnce(
        document.body,
        '.o_Follower',
        "should have follower component"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_editButton',
        "should display an edit button"
    );

    await click('.o_Follower_editButton');
    assert.verifySteps(
        ['fetch_subtypes'],
        "clicking on edit follower should fetch subtypes"
    );
    assert.containsOnce(
        document.body,
        '.o_FollowerSubtypeList',
        "A dialog allowing to edit follower subtypes should have been created"
    );
});

QUnit.test('edit follower and close subtype dialog', async function (assert) {
    assert.expect(6);

    const pyEnv = await startServer();
    const [threadId, partnerId] = pyEnv['res.partner'].create([{}, {}]);
    pyEnv['mail.followers'].create({
        is_active: true,
        partner_id: partnerId,
        res_id: threadId,
        res_model: 'res.partner',
    });
    const { click, createChatterContainerComponent } = await start({
        async mockRPC(route, args) {
            if (route.includes('/mail/read_subscription_data')) {
                assert.step('fetch_subtypes');
                return [{
                    default: true,
                    followed: true,
                    internal: false,
                    id: 1,
                    name: "Dummy test",
                    res_model: 'res.partner'
                }];
            }
            return this._super(...arguments);
        },
    });
    await createChatterContainerComponent({
        threadId,
        threadModel: 'res.partner',
    });
    await click('.o_FollowerListMenu_buttonFollowers');
    assert.containsOnce(
        document.body,
        '.o_Follower',
        "should have follower component"
    );
    assert.containsOnce(
        document.body,
        '.o_Follower_editButton',
        "should display an edit button"
    );

    await click('.o_Follower_editButton');
    assert.verifySteps(
        ['fetch_subtypes'],
        "clicking on edit follower should fetch subtypes"
    );
    assert.containsOnce(
        document.body,
        '.o_FollowerSubtypeList',
        "dialog allowing to edit follower subtypes should have been created"
    );

    await click('.o_FollowerSubtypeList_closeButton');
    assert.containsNone(
        document.body,
        '.o_DialogManager_dialog',
        "follower subtype dialog should be closed after clicking on close button"
    );
});

});
});
