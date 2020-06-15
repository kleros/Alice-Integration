/* eslint-disable no-undef */ // Avoid the linter considering truffle elements as undef.
const { BN, expectRevert, time } = require('openzeppelin-test-helpers')
const { soliditySha3 } = require('web3-utils')

const Ida = artifacts.require('Ida')
const Arbitrator = artifacts.require('EnhancedAppealableArbitrator')
const Validator = artifacts.require('Validator')
const Escrow = artifacts.require('Escrow')
const ClaimsRegistry = artifacts.require('ClaimsRegistry')

contract('Validator', function(accounts) {
  const governor = accounts[0] // Governor is also a service provider for IDA.
  const supporter = accounts[1]
  const challenger = accounts[2]
  const other = accounts[9]
  const arbitratorExtraData = '0x85'
  const arbitrationCost = 1000

  const appealTimeOut = 180
  const executionTimeout = 600
  const baseDeposit = 2000
  const sharedStakeMultiplier = 5000
  const winnerStakeMultiplier = 2000
  const loserStakeMultiplier = 8000
  const metaEvidence = 'test.json'

  let arbitrator
  let MULTIPLIER_DIVISOR
  let key
  let ID
  let value
  let deposit
  beforeEach('initialize the contract', async function() {
    key = soliditySha3('key1')
    value = web3.utils.padLeft(web3.utils.numberToHex(50), 64) // 50.

    arbitrator = await Arbitrator.new(
      arbitrationCost,
      governor,
      arbitratorExtraData,
      appealTimeOut,
      { from: governor }
    )

    await arbitrator.changeArbitrator(arbitrator.address)
    await arbitrator.createDispute(3, arbitratorExtraData, {
      from: other,
      value: arbitrationCost
    }) // Create a dispute so the index in tests will not be a default value.

    validator = await Validator.new(
      arbitrator.address,
      arbitratorExtraData,
      metaEvidence,
      executionTimeout,
      baseDeposit,
      sharedStakeMultiplier,
      winnerStakeMultiplier,
      loserStakeMultiplier,
      { from: governor }
    )

    claimsRegistry = await ClaimsRegistry.new()
    escrow = await Escrow.new(
      other, // Payment token.
      1000,
      { from: governor }
    )

    ida = await Ida.new(
      other, // Payment token.
      other, // Impact promise.
      escrow.address,
      claimsRegistry.address,
      'TestIda',
      2, // Promise number.
      50, // Price of a single promise.
      validator.address,
      -1, // End time. Just set to maximum.
      governor, // Service provider.
      { from: governor }
    )

    await escrow.transferOwnership(ida.address, { from: governor })
    await claimsRegistry.setClaim(ida.address, key, value, { from: governor })

    MULTIPLIER_DIVISOR = (await validator.MULTIPLIER_DIVISOR()).toNumber()

    deposit =
      arbitrationCost +
      (arbitrationCost * sharedStakeMultiplier) / MULTIPLIER_DIVISOR +
      baseDeposit
    ID = soliditySha3(ida.address, key, governor)
  })

  it('Should set the correct values in constructor', async () => {
    assert.equal(await validator.arbitrator(), arbitrator.address)
    assert.equal(await validator.arbitratorExtraData(), arbitratorExtraData)
    assert.equal(await validator.governor(), governor)
    assert.equal(await validator.executionTimeout(), executionTimeout)
    assert.equal(await validator.baseDeposit(), baseDeposit)
    assert.equal(await validator.sharedStakeMultiplier(), sharedStakeMultiplier)
    assert.equal(await validator.winnerStakeMultiplier(), winnerStakeMultiplier)
    assert.equal(await validator.loserStakeMultiplier(), loserStakeMultiplier)
  })

  it('Should create a report, set correct values and fire an event', async () => {
    let nbPending

    await expectRevert(
      validator.makeReport(ida.address, key, 1, { from: other }),
      'Only the service provider can make a report.'
    )
    nbPending = (await ida.nbPending()).toNumber()
    assert.equal(nbPending, 0, 'Ida should not have registered any reports')

    txMakeReport = await validator.makeReport(ida.address, key, 1, {
      from: governor
    })

    const report = await validator.reports(ID)
    assert.equal(report[0], ida.address, 'The report has incorrect IDA address')
    assert.equal(report[1], key, 'The report has incorrect promise key')
    assert.equal(report[2].toNumber(), 1, 'The report has incorrect status')
    assert.equal(report[8].toNumber(), 1, 'The report has incorrect outcome')

    nbPending = (await ida.nbPending()).toNumber()
    assert.equal(nbPending, 1, 'Ida should have one report registered')
    assert.equal(
      await ida.reportRegistered(key),
      true,
      'IDA should have marked the report as registered'
    )

    // Event check
    assert.equal(
      txMakeReport.logs[0].event,
      'ReportCreated',
      'The event ReportCreated has not been created'
    )
    assert.equal(
      txMakeReport.logs[0].args._ida,
      ida.address,
      'The event has wrong ida address'
    )
    assert.equal(
      txMakeReport.logs[0].args._key,
      key,
      'The event has wrong promise key'
    )
    assert.equal(
      txMakeReport.logs[0].args._ID,
      ID,
      'The event has wrong report ID'
    )

    // Check that can't make the same report 2nd time
    await expectRevert(
      validator.makeReport(ida.address, key, 1, { from: governor }),
      'The report for this impact promise has already been created.'
    )
  })

  it('Should set correct values when the report is challenged and fire Evidence event', async () => {
    await expectRevert(
      validator.challengeReport(ID, 'Evidence.json', {
        from: challenger,
        value: deposit
      }),
      'The report should be in Created status.'
    )

    await validator.makeReport(ida.address, key, 1, { from: governor })

    await expectRevert(
      validator.challengeReport(ID, 'Evidence.json', {
        from: challenger,
        value: deposit - 1
      }),
      'You must fully fund your side.'
    )
    txChallenge = await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: 5 * deposit
    }) // deliberately overpay

    const report = await validator.reports(ID)
    assert.equal(
      report[2].toNumber(),
      2,
      'The report should have status Challenged'
    )
    assert.equal(
      report[6],
      challenger,
      'The report has incorrect challenger address'
    )

    const round = await validator.getRoundInfo(ID, 0)
    assert.equal(
      round[1][2].toNumber(),
      deposit,
      'Challenger paidFees has not been registered correctly'
    )
    assert.equal(
      round[2][2],
      true,
      'Should register that challenger paid his fees'
    )
    assert.equal(
      round[3].toNumber(),
      deposit,
      'FeeRewards has not been registered correctly'
    )

    const evidenceGroupID = parseInt(ID, 16)

    // Event check
    assert.equal(
      txChallenge.logs[0].event,
      'Evidence',
      'The event Evidence has not been created'
    )
    assert.equal(
      txChallenge.logs[0].args._arbitrator,
      arbitrator.address,
      'The event has wrong arbitrator'
    )
    assert.equal(
      txChallenge.logs[0].args._evidenceGroupID,
      evidenceGroupID,
      'The event has wrong evidenceGroup ID'
    )
    assert.equal(
      txChallenge.logs[0].args._party,
      challenger,
      'The event has wrong party'
    )
    assert.equal(
      txChallenge.logs[0].args._evidence,
      'Evidence.json',
      'The event has wrong evidence'
    )

    // Check that not possible to challenge again
    await expectRevert(
      validator.challengeReport(ID, 'Evidence.json', {
        from: challenger,
        value: deposit
      }),
      'The report should be in Created status.'
    )
  })

  it('Should not challenge after the timeout', async () => {
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await time.increase(executionTimeout + 1)

    await expectRevert(
      validator.challengeReport(ID, 'Evidence.json', {
        from: challenger,
        value: deposit
      }),
      'Time to challenge the report has passed.'
    )
  })

  it('Should set correct values when the report is confirmed, create a dispute and emit events', async () => {
    await expectRevert(
      validator.confirmReport(ID, 'Evidence2.json', {
        from: supporter,
        value: deposit
      }),
      'The report should be in Challenged status.'
    )

    await validator.makeReport(ida.address, key, 1, { from: governor })
    await expectRevert(
      validator.confirmReport(ID, 'Evidence2.json', {
        from: supporter,
        value: deposit
      }),
      'The report should be in Challenged status.'
    )

    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await expectRevert(
      validator.confirmReport(ID, 'Evidence2.json', {
        from: supporter,
        value: deposit - 1
      }),
      'You must fully fund your side.'
    )

    txConfirm = await validator.confirmReport(ID, 'Evidence2.json', {
      from: supporter,
      value: deposit * 10
    }) // Deliberately overpay.

    const report = await validator.reports(ID)
    assert.equal(
      report[2].toNumber(),
      3,
      'The report should have status Disputed'
    )
    assert.equal(report[3].toNumber(), 1, 'The report has incorrect disputeID')
    assert.equal(
      report[5],
      supporter,
      'The report has incorrect supporter address'
    )

    const round = await validator.getRoundInfo(ID, 0)
    assert.equal(
      round[1][1].toNumber(),
      deposit,
      'Supporter paidFees has not been registered correctly'
    )
    assert.equal(
      round[2][1],
      true,
      'Should register that supporter paid his fees'
    )
    assert.equal(
      round[3].toNumber(),
      6000, // deposit * 2 - arbitrationCost
      'FeeRewards has not been registered correctly after report is confirmed'
    )

    // Dispute
    const dispute = await arbitrator.disputes(1)
    assert.equal(
      dispute[0],
      validator.address,
      'Arbitrable not set up properly'
    )
    assert.equal(
      dispute[1].toNumber(),
      2,
      'Number of choices not set up properly'
    )
    assert.equal(
      dispute[2].toNumber(),
      arbitrationCost,
      'Arbitration cost is not set up properly in the dispute'
    )
    const disputeIDToReportID = await validator.disputeIDToReportID(1)
    assert.equal(disputeIDToReportID, ID, 'Incorrect disputeIDToReportID value')

    // Events
    const evidenceGroupID = parseInt(ID, 16)
    assert.equal(
      txConfirm.logs[0].event,
      'Dispute',
      'The event Dispute has not been created'
    )
    assert.equal(
      txConfirm.logs[0].args._arbitrator,
      arbitrator.address,
      'The event has wrong arbitrator'
    )
    assert.equal(
      txConfirm.logs[0].args._disputeID.toNumber(),
      1,
      'The event has wrong dispute ID'
    )
    assert.equal(
      txConfirm.logs[0].args._metaEvidenceID.toNumber(),
      0,
      'The event has wrong metaevidence ID'
    )
    assert.equal(
      txConfirm.logs[0].args._evidenceGroupID,
      evidenceGroupID,
      'The event has wrong evidenceGroup ID'
    )

    assert.equal(
      txConfirm.logs[1].event,
      'Evidence',
      'The event Evidence has not been created'
    )
    assert.equal(
      txConfirm.logs[1].args._arbitrator,
      arbitrator.address,
      'The event has wrong arbitrator'
    )
    assert.equal(
      txConfirm.logs[1].args._evidenceGroupID,
      evidenceGroupID,
      'The event has wrong evidenceGroup ID'
    )
    assert.equal(
      txConfirm.logs[1].args._party,
      supporter,
      'The event has wrong party address'
    )
    assert.equal(
      txConfirm.logs[1].args._evidence,
      'Evidence2.json',
      'The event has wrong evidence'
    )

    // Check that not possible to confirm 2nd time
    await expectRevert(
      validator.confirmReport(ID, 'Evidence2.json', {
        from: supporter,
        value: deposit
      }),
      'The report should be in Challenged status.'
    )
    // Check that Disputed report can't be approved
    await time.increase(executionTimeout + 1)
    await expectRevert(
      validator.approveReport(ID, { from: governor }),
      'The report should be either in Created or Challenged status.'
    )
  })

  it('Should not confirm after the timeout', async () => {
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await time.increase(executionTimeout + 1)

    await expectRevert(
      validator.confirmReport(ID, 'Evidence2.json', {
        from: supporter,
        value: deposit
      }),
      'Time to confirm the report has passed.'
    )
  })

  it('Should correctly approve unchallenged report', async () => {
    await expectRevert(
      validator.approveReport(ID, { from: governor }),
      'The report should be either in Created or Challenged status.'
    )
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await expectRevert(
      validator.approveReport(ID, { from: governor }),
      'The timeout has not passed yet.'
    )

    await time.increase(executionTimeout + 1)
    await validator.approveReport(ID, { from: governor })

    const report = await validator.reports(ID)
    assert.equal(
      report[2].toNumber(),
      4,
      'The report should have status Resolved'
    )
    assert.equal(
      report[8].toNumber(),
      1,
      'The outcome should not be changed for an approved unchallenged report'
    )
  })

  it('Should correctly approve the report that was challenged and withdraw the deposit', async () => {
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await expectRevert(
      validator.approveReport(ID, { from: governor }),
      'The timeout has not passed yet.'
    )

    await time.increase(executionTimeout + 1)
    await validator.approveReport(ID, { from: governor })

    const report = await validator.reports(ID)
    assert.equal(
      report[2].toNumber(),
      4,
      'The report should have status Resolved'
    )
    assert.equal(report[8].toNumber(), 0, 'The outcome should be inverted to 0')

    // Withdrawal
    const oldBalanceChallenger = await web3.eth.getBalance(challenger)
    await validator.withdrawFeesAndRewards(challenger, ID, 0, {
      from: governor
    })
    const newBalanceChallenger = await web3.eth.getBalance(challenger)
    assert(
      new BN(newBalanceChallenger).eq(
        new BN(oldBalanceChallenger).add(new BN(deposit))
      ),
      'The challenger was not reimbursed correctly'
    )

    // Check the outcome inversion for 0 outcome
    const key2 = soliditySha3('key2')
    await claimsRegistry.setClaim(ida.address, key2, value, { from: governor })
    const ID2 = soliditySha3(ida.address, key2, governor)
    await validator.makeReport(ida.address, key2, 0, { from: governor })
    await validator.challengeReport(ID2, 'Evidence.json', {
      from: challenger,
      value: deposit
    })

    await time.increase(executionTimeout + 1)
    await validator.approveReport(ID2, { from: governor })

    const report2 = await validator.reports(ID2)
    assert.equal(
      report2[8].toNumber(),
      1,
      'The outcome should be inverted to 1'
    )
  })

  it('Should demand correct appeal fees and register that appeal fee has been paid', async () => {
    // Appeal fee is the same as arbitration fee for this arbitrator.
    const loserAppealFee =
      arbitrationCost +
      (arbitrationCost * loserStakeMultiplier) / MULTIPLIER_DIVISOR // 1800

    let roundInfo

    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await expectRevert(
      validator.fundAppeal(ID, 2, { from: challenger, value: deposit }), // total appeal cost is lower than deposit and depends on the winner
      'The report must have a pending dispute.'
    )
    await validator.confirmReport(ID, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(1, 2)

    await expectRevert(
      validator.fundAppeal(ID, 0, { from: supporter, value: loserAppealFee }),
      'Invalid party.'
    )

    // Deliberately overpay to check that only required fee amount will be registered.
    await validator.fundAppeal(ID, 1, {
      from: supporter,
      value: loserAppealFee * 3
    })

    // Fund appeal again to see if it doesn't cause anything.
    await validator.fundAppeal(ID, 1, {
      from: supporter,
      value: loserAppealFee * 3
    })

    roundInfo = await validator.getRoundInfo(ID, 1)

    assert.equal(
      roundInfo[1][1].toNumber(),
      loserAppealFee,
      'Registered fee of the supporter is incorrect'
    )
    assert.equal(
      roundInfo[2][1],
      true,
      'Did not register that the supporter successfully paid his fees'
    )

    assert.equal(
      roundInfo[1][2].toNumber(),
      0,
      'Should not register any payments for challenger'
    )
    assert.equal(
      roundInfo[2][2],
      false,
      'Should not register that challenger successfully paid fees'
    )
    assert.equal(
      roundInfo[3].toNumber(),
      loserAppealFee,
      'Incorrect FeeRewards value'
    )

    const winnerAppealFee =
      arbitrationCost +
      (arbitrationCost * winnerStakeMultiplier) / MULTIPLIER_DIVISOR // 1200

    // Increase time to make sure winner can pay in 2nd half.
    await time.increase(appealTimeOut / 2 + 1)

    await validator.fundAppeal(ID, 2, {
      from: challenger,
      value: winnerAppealFee - 1
    }) // Underpay to see if it's registered correctly

    roundInfo = await validator.getRoundInfo(ID, 1)

    assert.equal(
      roundInfo[1][2].toNumber(),
      winnerAppealFee - 1,
      'Registered partial fee of the challenger is incorrect'
    )
    assert.equal(
      roundInfo[2][2],
      false,
      'Should not register that the challenger successfully paid his fees after partial payment'
    )

    assert.equal(
      roundInfo[3].toNumber(),
      loserAppealFee + winnerAppealFee - 1,
      'Incorrect FeeRewards value after partial payment'
    )

    await validator.fundAppeal(ID, 2, { from: challenger, value: 1 })
    roundInfo = await validator.getRoundInfo(ID, 1)

    assert.equal(
      roundInfo[1][2].toNumber(),
      winnerAppealFee,
      'Registered fee of challenger is incorrect'
    )
    assert.equal(
      roundInfo[2][2],
      true,
      'Did not register that challenger successfully paid his fees'
    )

    assert.equal(
      roundInfo[3].toNumber(),
      winnerAppealFee + loserAppealFee - arbitrationCost,
      'Incorrect fee rewards value'
    )

    // If both sides pay their fees it starts new appeal round. Check that both sides have their value set to default.
    roundInfo = await validator.getRoundInfo(ID, 2)
    assert.equal(
      roundInfo[2][1],
      false,
      'Appeal fee payment for requester should not be registered in the new round'
    )
    assert.equal(
      roundInfo[2][2],
      false,
      'Appeal fee payment for challenger should not be registered in the new round'
    )
  })

  it('Should not be possible for loser to fund appeal if first half of appeal period has passed', async () => {
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })
    await arbitrator.giveRuling(1, 2)

    const loserAppealFee =
      arbitrationCost +
      (arbitrationCost * loserStakeMultiplier) / MULTIPLIER_DIVISOR
    time.increase(appealTimeOut / 2 + 1)
    await expectRevert(
      validator.fundAppeal(ID, 1, { from: supporter, value: loserAppealFee }),
      'The loser must contribute during the first half of the appeal period.'
    )
  })

  it('Should set correct values when arbitrator refused to rule', async () => {
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(1, 0)
    await time.increase(appealTimeOut + 1)
    await arbitrator.giveRuling(1, 0)

    const report = await validator.reports(ID)
    assert.equal(
      report[2].toNumber(),
      4,
      'The report should have status Resolved'
    )
    assert.equal(report[7].toNumber(), 0, 'The report should have 0 ruling')
    assert.equal(
      report[8].toNumber(),
      0,
      'The outcome should be set to Failure with 0 ruling'
    )

    // Check the 2nd possible outcome for correct behaviour as well

    const key2 = soliditySha3('key2')
    await claimsRegistry.setClaim(ida.address, key2, value, { from: governor })
    const ID2 = soliditySha3(ida.address, key2, governor)
    await validator.makeReport(ida.address, key2, 0, { from: governor })
    await validator.challengeReport(ID2, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID2, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(2, 0)
    await time.increase(appealTimeOut + 1)
    await arbitrator.giveRuling(2, 0)

    const report2 = await validator.reports(ID2)
    assert.equal(
      report2[8].toNumber(),
      0,
      'The Failure outcome should stay the same with 0 ruling'
    )
  })

  it('Should set correct values when supporter wins', async () => {
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(1, 1)
    await time.increase(appealTimeOut + 1)
    await arbitrator.giveRuling(1, 1)

    const report = await validator.reports(ID)
    assert.equal(
      report[2].toNumber(),
      4,
      'The report should have status Resolved'
    )
    assert.equal(report[7].toNumber(), 1, 'The report has incorrect ruling')
    assert.equal(
      report[8].toNumber(),
      1,
      'The outcome should be set to Success'
    )

    // Check the 2nd possible outcome for correct behaviour as well

    const key2 = soliditySha3('key2')
    await claimsRegistry.setClaim(ida.address, key2, value, { from: governor })
    const ID2 = soliditySha3(ida.address, key2, governor)
    await validator.makeReport(ida.address, key2, 0, { from: governor })
    await validator.challengeReport(ID2, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID2, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(2, 1)
    await time.increase(appealTimeOut + 1)
    await arbitrator.giveRuling(2, 1)

    const report2 = await validator.reports(ID2)
    assert.equal(
      report2[8].toNumber(),
      0,
      'The Failure outcome should not be changed'
    )
  })

  it('Should set correct values when challenger wins', async () => {
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(1, 2)
    await time.increase(appealTimeOut + 1)
    await arbitrator.giveRuling(1, 2)

    const report = await validator.reports(ID)
    assert.equal(
      report[2].toNumber(),
      4,
      'The report should have status Resolved'
    )
    assert.equal(report[7].toNumber(), 2, 'The report has incorrect ruling')
    assert.equal(report[8].toNumber(), 0, 'The outcome should be inverted')

    // Check the 2nd possible outcome for correct behaviour as well

    const key2 = soliditySha3('key2')
    await claimsRegistry.setClaim(ida.address, key2, value, { from: governor })
    const ID2 = soliditySha3(ida.address, key2, governor)
    await validator.makeReport(ida.address, key2, 0, { from: governor })
    await validator.challengeReport(ID2, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID2, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(2, 2)
    await time.increase(appealTimeOut + 1)
    await arbitrator.giveRuling(2, 2)

    const report2 = await validator.reports(ID2)
    assert.equal(
      report2[8].toNumber(),
      1,
      'The Failure outcome should be inverted'
    )
  })

  it('Should change the ruling if the loser paid appeal fee while winner did not', async () => {
    const loserAppealFee =
      arbitrationCost +
      (arbitrationCost * loserStakeMultiplier) / MULTIPLIER_DIVISOR

    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(1, 1)

    await validator.fundAppeal(ID, 2, {
      from: challenger,
      value: loserAppealFee
    })
    await time.increase(appealTimeOut + 1)
    await arbitrator.giveRuling(1, 1)

    const report = await validator.reports(ID)
    assert.equal(
      report[7].toNumber(),
      2,
      'The ruling should be switched in favor of challenger'
    )
    assert.equal(
      report[8].toNumber(),
      0,
      'The outcome should be inverted to Failure'
    )
  })

  it('Should withdraw fees correctly', async () => {
    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.challengeReport(ID, 'Evidence.json', {
      from: challenger,
      value: deposit
    })
    await validator.confirmReport(ID, 'Evidence2.json', {
      from: supporter,
      value: deposit
    })

    await arbitrator.giveRuling(1, 2)

    // 1st appeal round.
    const loserAppealFee =
      arbitrationCost +
      (arbitrationCost * loserStakeMultiplier) / MULTIPLIER_DIVISOR

    await validator.fundAppeal(ID, 1, {
      from: other,
      value: loserAppealFee * 0.8
    })
    await validator.fundAppeal(ID, 1, {
      from: supporter,
      value: loserAppealFee * 0.8
    })

    const winnerAppealFee =
      arbitrationCost +
      (arbitrationCost * winnerStakeMultiplier) / MULTIPLIER_DIVISOR

    await validator.fundAppeal(ID, 2, {
      from: challenger,
      value: winnerAppealFee * 0.1
    })
    await validator.fundAppeal(ID, 2, {
      from: challenger,
      value: winnerAppealFee * 0.3
    })

    await validator.fundAppeal(ID, 2, {
      from: other,
      value: winnerAppealFee * 5
    })

    // Check that can't withdraw if request is unresolved
    await expectRevert(
      validator.withdrawFeesAndRewards(supporter, ID, 1, { from: governor }),
      'The report must be resolved.'
    )

    await arbitrator.giveRuling(2, 2)
    await time.increase(appealTimeOut + 1)
    await arbitrator.giveRuling(2, 2)

    let oldBalanceSupporter = await web3.eth.getBalance(supporter)
    await validator.withdrawFeesAndRewards(supporter, ID, 1, {
      from: governor
    })
    let newBalanceSupporter = await web3.eth.getBalance(supporter)
    assert(
      new BN(newBalanceSupporter).eq(new BN(oldBalanceSupporter)),
      'The balance of the supporter should stay the same'
    )

    let oldBalanceChallenger = await web3.eth.getBalance(challenger)
    await validator.withdrawFeesAndRewards(challenger, ID, 1, {
      from: governor
    })
    let newBalanceChallenger = await web3.eth.getBalance(challenger)
    assert(
      new BN(newBalanceChallenger).eq(
        new BN(oldBalanceChallenger).add(new BN(800))
      ), // Challenger paid 40% of his fees (feeRewards pool is 2000 (3000 paidFees - 1000 appealFees))
      'The challenger was not reimbursed correctly'
    )

    const oldBalanceCrowdfunder = await web3.eth.getBalance(other)
    await validator.withdrawFeesAndRewards(other, ID, 1, { from: governor })
    const newBalanceCrowdfunder = await web3.eth.getBalance(other)
    assert(
      new BN(newBalanceCrowdfunder).eq(
        new BN(oldBalanceCrowdfunder).add(new BN(1200))
      ), // Crowdfunder paid 60% of the fees
      'The crowdfunder was not reimbursed correctly'
    )

    // Check that contributions are set to 0
    const contributions = await validator.getContributions(ID, 1, other)
    assert.equal(
      contributions[1].toNumber(),
      0,
      'The 1st contribution should be set to 0'
    )
    assert.equal(
      contributions[2].toNumber(),
      0,
      'The 2nd contribution should be set to 0'
    )

    // Check withdraw from the 0 round
    oldBalanceSupporter = await web3.eth.getBalance(supporter)
    await validator.withdrawFeesAndRewards(supporter, ID, 0, {
      from: governor
    })
    newBalanceSupporter = await web3.eth.getBalance(supporter)
    assert(
      new BN(newBalanceSupporter).eq(new BN(oldBalanceSupporter)),
      'The balance of the supporter should stay the same 0 round'
    )

    oldBalanceChallenger = await web3.eth.getBalance(challenger)
    await validator.withdrawFeesAndRewards(challenger, ID, 0, {
      from: governor
    })
    newBalanceChallenger = await web3.eth.getBalance(challenger)
    assert(
      new BN(newBalanceChallenger).eq(
        new BN(oldBalanceChallenger).add(new BN(6000))
      ), // Challenger gets all feeRewards
      'The challenger was not reimbursed correctly 0 round'
    )
  })

  it('Should correctly register report outcomes', async () => {
    const key2 = soliditySha3('key2')
    await claimsRegistry.setClaim(ida.address, key2, value, { from: governor })
    const ID2 = soliditySha3(ida.address, key2, governor)
    let nbPending
    let validatedNb

    await validator.makeReport(ida.address, key, 1, { from: governor })
    await validator.makeReport(ida.address, key2, 0, { from: governor })
    await time.increase(executionTimeout + 1)
    await expectRevert(
      validator.registerOutcome(ID, { from: governor }),
      'The report should be resolved and not already registered by IDA.'
    )
    await validator.approveReport(ID, { from: governor })
    await validator.approveReport(ID2, { from: governor })

    nbPending = (await ida.nbPending()).toNumber()
    assert.equal(nbPending, 2, 'Ida should have two pending reports')
    validatedNb = (await ida.validatedNumber()).toNumber()
    assert.equal(
      validatedNb,
      0,
      'Ida should not have any validated reports so far'
    )

    // 1st report
    await validator.registerOutcome(ID, { from: governor })
    const report = await validator.reports(ID)
    assert.equal(report[9], true, 'The report should be marked as registered')

    nbPending = (await ida.nbPending()).toNumber()
    assert.equal(
      nbPending,
      1,
      'Ida should have one pending report after registering the first outcome'
    )
    validatedNb = (await ida.validatedNumber()).toNumber()
    assert.equal(
      validatedNb,
      1,
      'Ida should have one validated report after registering the first outcome'
    )

    // 2nd report

    await validator.registerOutcome(ID2, { from: governor })

    nbPending = (await ida.nbPending()).toNumber()
    assert.equal(nbPending, 0, 'Ida should not have any pending reports left')
    validatedNb = (await ida.validatedNumber()).toNumber()
    assert.equal(
      validatedNb,
      1,
      'Validated number should not increase after reporting Failure outcome'
    )

    assert.equal(
      await ida.reportRegistered(key),
      false,
      'The flag should be false for the first promise'
    )
    assert.equal(
      await ida.reportRegistered(key2),
      false,
      'The flag should be false for the second promise'
    )

    // Check that not possible to report 2nd time
    await expectRevert(
      validator.registerOutcome(ID, { from: governor }),
      'The report should be resolved and not already registered by IDA.'
    )
  })

  it('Should not allow to make a report that does not have a claim set', async () => {
    const key2 = soliditySha3('key2')

    await expectRevert(
      validator.makeReport(ida.address, key2, 0, { from: governor }),
      'A claim must be registered before registering a report'
    )
  })

  it('Should submit evidence and fire the event', async () => {
    await expectRevert(
      validator.submitEvidence(ID, 'Evidence3.json', { from: other }),
      'The report should exist and not be resolved.'
    )
    await validator.makeReport(ida.address, key, 1, { from: governor })
    txEvidence = await validator.submitEvidence(ID, 'Evidence3.json', {
      from: other
    })

    const evidenceGroupID = parseInt(ID, 16)

    assert.equal(
      txEvidence.logs[0].event,
      'Evidence',
      'The event Evidence has not been created'
    )
    assert.equal(
      txEvidence.logs[0].args._arbitrator,
      arbitrator.address,
      'The event has wrong arbitrator'
    )
    assert.equal(
      txEvidence.logs[0].args._evidenceGroupID,
      evidenceGroupID,
      'The event has wrong evidenceGroup ID'
    )
    assert.equal(
      txEvidence.logs[0].args._party,
      other,
      'The event has wrong party'
    )
    assert.equal(
      txEvidence.logs[0].args._evidence,
      'Evidence3.json',
      'The event has wrong evidence'
    )

    await time.increase(executionTimeout + 1)
    await validator.approveReport(ID, { from: governor })

    // For Resolved status
    await expectRevert(
      validator.submitEvidence(ID, 'Evidence3.json', { from: other }),
      'The report should exist and not be resolved.'
    )
  })

  it('Should make governance changes', async () => {
    await expectRevert(
      validator.changeExecutionTimeout(31, { from: other }),
      'The caller must be the governor.'
    )
    await validator.changeExecutionTimeout(31, { from: governor })
    assert.equal(
      (await validator.executionTimeout()).toNumber(),
      31,
      'Incorrect executionTimeout value'
    )

    await expectRevert(
      validator.changeBaseDeposit(212, { from: other }),
      'The caller must be the governor.'
    )
    await validator.changeBaseDeposit(212, { from: governor })
    assert.equal(
      (await validator.baseDeposit()).toNumber(),
      212,
      'Incorrect baseDeposit value'
    )

    await expectRevert(
      validator.changeSharedStakeMultiplier(51, { from: other }),
      'The caller must be the governor.'
    )
    await validator.changeSharedStakeMultiplier(51, { from: governor })
    assert.equal(
      (await validator.sharedStakeMultiplier()).toNumber(),
      51,
      'Incorrect sharedStakeMultiplier value'
    )

    await expectRevert(
      validator.changeWinnerStakeMultiplier(101, { from: other }),
      'The caller must be the governor.'
    )
    await validator.changeWinnerStakeMultiplier(101, { from: governor })
    assert.equal(
      (await validator.winnerStakeMultiplier()).toNumber(),
      101,
      'Incorrect winnerStakeMultiplier value'
    )

    await expectRevert(
      validator.changeGovernor(other, { from: other }),
      'The caller must be the governor.'
    )
    await validator.changeGovernor(other, { from: governor })
    assert.equal(await validator.governor(), other, 'Incorrect governor value')

    // Other is now governor
    await expectRevert(
      validator.changeLoserStakeMultiplier(4222, { from: governor }),
      'The caller must be the governor.'
    )
    await validator.changeLoserStakeMultiplier(4222, { from: other })
    assert.equal(
      (await validator.loserStakeMultiplier()).toNumber(),
      4222,
      'Incorrect loserStakeMultiplier value'
    )
  })
})
