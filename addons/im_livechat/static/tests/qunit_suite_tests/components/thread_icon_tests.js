/** @odoo-module **/

import {
    afterNextRender,
    start,
    startServer,
} from '@mail/../tests/helpers/test_utils';

QUnit.module('im_livechat', {}, function () {
QUnit.module('components', {}, function () {
QUnit.module('thread_icon_tests.js');

QUnit.test('livechat: public website visitor is typing', async function (assert) {
    assert.expect(4);

    const pyEnv = await startServer();
    const mailChannelId1 = pyEnv['mail.channel'].create({
        anonymous_name: "Visitor 20",
        channel_last_seen_partner_ids: [
            [0, 0, { partner_id: pyEnv.currentPartnerId }],
            [0, 0, { partner_id: pyEnv.publicPartnerId }],
        ],
        channel_type: 'livechat',
        livechat_operator_id: pyEnv.currentPartnerId,
    });
    const { createRootMessagingComponent, messaging } = await start();
    const thread = messaging.models['Thread'].findFromIdentifyingData({
        id: mailChannelId1,
        model: 'mail.channel',
    });
    await createRootMessagingComponent('ThreadIcon', { thread });
    assert.containsOnce(
        document.body,
        '.o_ThreadIcon',
        "should have thread icon"
    );
    assert.containsOnce(
        document.body,
        '.o_ThreadIcon .fa.fa-comments',
        "should have default livechat icon"
    );

    const mailChannel1 = pyEnv['mail.channel'].searchRead([['id', '=', mailChannelId1]])[0];
    // simulate receive typing notification from livechat visitor "is typing"
    await afterNextRender(() => {
        pyEnv['bus.bus']._sendone(mailChannel1, 'mail.channel.partner/typing_status', {
            'channel_id': mailChannelId1,
            'is_typing': true,
            'partner_id': messaging.publicPartners[0].id,
            'partner_name': messaging.publicPartners[0].name,
        });
    });
    assert.containsOnce(
        document.body,
        '.o_ThreadIcon_typing',
        "should have thread icon with visitor currently typing"
    );
    assert.strictEqual(
        document.querySelector('.o_ThreadIcon_typing').title,
        "Visitor 20 is typing...",
        "title of icon should tell visitor is currently typing"
    );
});

});
});
