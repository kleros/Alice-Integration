/**
 *  @authors: [@unknownunknown1]
 *  @reviewers: []
 *  @auditors: []
 *  @bounties: []
 *  @deployments: []
 */

pragma solidity ^0.5.13;

/* solium-disable max-len*/
import { IArbitrable, IArbitrator } from "@kleros/erc-792/contracts/IArbitrator.sol";
import { IEvidence } from "@kleros/erc-792/contracts/erc-1497/IEvidence.sol";
import { CappedMath } from "@kleros/ethereum-libraries/contracts/CappedMath.sol";

interface IdaInterface {

    /** @dev Get IDA service provider.
     *  @return The address of the service provider.
     */
    function serviceProvider() external returns(address);

    /** @dev Validate the fullfilled promise.
     *  @param  _key The ID of the promise.
     */
    function validatePromise(bytes32 _key) external;
}

/** @title Validator
 *  Validator acts as a connector between Kleros arbitrator and Impact Delivery Agreement (IDA) contract. Its purpose is to validate reports about the fullfillment of impact promises.
 *  Each report is identified by its ID which is a hash of the corresponding impact promise, IDA address and service provider.
 *  NOTE: This contract trusts that the Arbitrator is honest and will not reenter or modify its costs during a call.
 *  The arbitrator must support appeal period.
 */
contract Validator is IArbitrable, IEvidence {

    using CappedMath for uint;

    /* Enums */

    enum Outcome {
        FAILURE, // The impact promise was not fullfilled.
        SUCCESS // The promise was fullfilled.
    }

    enum Status {
        None, // Default status of a report. Indicates that the report for the promise wasn't created in this contract.
        Created, // The report is created and can be approved if not challenged within the timeout.
        Challenged, // The report is challenged and the challenge can be approved if no one confirms the report within the timeout.
        Disputed, // The dispute was raised in Kleros Court for jurors to decide whether the report is correct or not.
        Resolved // The report is resolved and can be validated by the IDA contract, if it's proved successful.
    }

    enum Party {
        None, // Party that is mapped with 0 dispute ruling.
        Supporter, // Party that confirms the correctness of the report. Note that it's only possible to confirm the report after challenge, because it's considered correct by default.
        Challenger // Party that challenges the correctness of the report.
    }

    /* Structs */

    struct Report {
        IdaInterface ida; // The address of the IDA contract that created the promise.
        bytes32 key; // The ID of the impact promise in the IDA contract.
        Status status; // Current status of the report.
        uint disputeID; // The ID of the dispute created in the arbitrator contract.
        uint lastActionTime; // The time of the last action performed on the report. Note that lastActionTime is updated only during timeout-related actions.
        address supporter; // Address of the party that confirms the report.
        address challenger; // Address of the party that challenges the report.
        Round[] rounds; // Tracks each round of a dispute.
        Party ruling; // Ruling given to the dispute by the arbitrator.
        Outcome outcome; // The reported outcome of the promise (e.g., Failure/Success).
    }

    // Some arrays below have 3 elements to map with the Party enums for better readability:
    // - 0: is unused, matches `Party.None`.
    // - 1: for `Party.Supporter`.
    // - 2: for `Party.Challenger`.
    struct Round {
        uint256[3] paidFees; // Tracks the fees paid by each side in this round.
        bool[3] hasPaid; // True when the side has fully paid its fee. False otherwise.
        uint256 feeRewards; // Sum of reimbursable fees and stake rewards available to the parties that made contributions to the side that ultimately wins a dispute.
        mapping(address => uint[3]) contributions; // Maps contributors to their contributions for each side.
    }

    /* Storage */

    IArbitrator public arbitrator; // The arbitrator contract.
    bytes public arbitratorExtraData; // Extra data to require particular dispute and appeal behaviour.

    uint RULING_OPTIONS = 2; // The amount of non 0 choices the arbitrator can give.

    address public governor; // The address that can make governance changes to the parameters of the contract.
    uint public executionTimeout; // Time in seconds during which the report can be challenged/confirmed.
    uint public baseDeposit; // The deposit a party has to pay to challenge/confirm the report.

    // Fee stake multipliers (in basis points).
    uint public sharedStakeMultiplier; // Multiplier for calculating the fee stake that must be paid in the case when there is no winner or loser (e.g., it's the first round or arbitrator refused to rule).
    uint public winnerStakeMultiplier; // Multiplier for calculating the fee stake paid by the party that won the previous round.
    uint public loserStakeMultiplier; // Multiplier for calculating the fee stake paid by the party that lost the previous round.
    uint public constant MULTIPLIER_DIVISOR = 10000; // Divisor parameter for multipliers.

    mapping (bytes32 => Report) public reports; // Maps the report ID to its data. reports[_ID].
    mapping (uint => bytes32) public disputeIDToReportID; // Maps a dispute ID to the ID of the disputed report. disputeIDToKey[_disputeID].

    /* Modifiers */

    modifier onlyGovernor {require(msg.sender == governor, "The caller must be the governor."); _;}

    /* Events */

    /**
     *  @dev Emitted when the report about the outcome of an impact promise is created.
     *  @param _ida The address of the IDA that created the promise.
     *  @param _key The identifier of the impact promise.
     *  @param _ID The ID of the report.
     */
    event ReportCreated(address indexed _ida, bytes32 indexed _key, bytes32 indexed _ID);


    /** @dev Constructor.
     *  @param _arbitrator The arbitrator of the contract.
     *  @param _arbitratorExtraData Extra data for the arbitrator.
     *  @param _metaEvidence The URI of the meta evidence object.
     *  @param _executionTimeout Time in seconds during which it is possible to challenge or confirm the report.
     *  @param _baseDeposit The deposit that must be paid by challenger or supporter.
     *  @param _sharedStakeMultiplier Multiplier of the arbitration cost that each party has to pay as fee stake for a round when there is no winner/loser in the previous round (e.g. when it's the first round or the arbitrator refused to arbitrate). In basis points.
     *  @param _winnerStakeMultiplier Multiplier of the arbitration cost that the winner has to pay as fee stake for a round in basis points.
     *  @param _loserStakeMultiplier Multiplier of the arbitration cost that the loser has to pay as fee stake for a round in basis points.
     */
    constructor(
        IArbitrator  _arbitrator,
        bytes memory _arbitratorExtraData,
        string memory _metaEvidence,
        uint _executionTimeout,
        uint _baseDeposit,
        uint _sharedStakeMultiplier,
        uint _winnerStakeMultiplier,
        uint _loserStakeMultiplier

    ) public {
        emit MetaEvidence(0, _metaEvidence);
        governor = msg.sender;
        arbitrator = _arbitrator;
        arbitratorExtraData = _arbitratorExtraData;
        executionTimeout = _executionTimeout;
        baseDeposit = _baseDeposit;
        sharedStakeMultiplier = _sharedStakeMultiplier;
        winnerStakeMultiplier = _winnerStakeMultiplier;
        loserStakeMultiplier = _loserStakeMultiplier;
    }

    /* External and Public */

    // ************************ //
    // *      Governance      * //
    // ************************ //

    /** @dev Change the duration of challenge/confirmation period.
     *  @param _executionTimeout The new duration of the execution timeout.
     */
    function changeExecutionTimeout(uint _executionTimeout) external onlyGovernor {
        executionTimeout = _executionTimeout;
    }

    /** @dev Change the base amount required as a deposit for challenge/confirmation.
     *  @param _baseDeposit The new base amount of wei required to challenge or confirm the report.
     */
    function changeBaseDeposit(uint _baseDeposit) external onlyGovernor {
        baseDeposit = _baseDeposit;
    }

    /** @dev Change the proportion of arbitration fees that must be paid as fee stake by parties when there is no winner or loser.
     *  @param _sharedStakeMultiplier Multiplier of arbitration fees that must be paid as fee stake. In basis points.
     */
    function changeSharedStakeMultiplier(uint _sharedStakeMultiplier) external onlyGovernor {
        sharedStakeMultiplier = _sharedStakeMultiplier;
    }

    /** @dev Change the proportion of arbitration fees that must be paid as fee stake by the winner of the previous round.
     *  @param _winnerStakeMultiplier Multiplier of arbitration fees that must be paid as fee stake. In basis points.
     */
    function changeWinnerStakeMultiplier(uint _winnerStakeMultiplier) external onlyGovernor {
        winnerStakeMultiplier = _winnerStakeMultiplier;
    }

    /** @dev Change the proportion of arbitration fees that must be paid as fee stake by the party that lost the previous round.
     *  @param _loserStakeMultiplier Multiplier of arbitration fees that must be paid as fee stake. In basis points.
     */
    function changeLoserStakeMultiplier(uint _loserStakeMultiplier) external onlyGovernor {
        loserStakeMultiplier = _loserStakeMultiplier;
    }

    // *********************** //
    // *       Reports       * //
    // *********************** //

    /** @dev Make a report about the fullfillment of the impact promise.
     *  @param _ida The address of the IDA that created the promise.
     *  @param _key A unique identifier (code) for the impact promise.
     *  @param _outcome Whether the promise was fullfilled or not.
     */
    function makeReport(IdaInterface _ida, bytes32 _key, Outcome _outcome) external {
        require(_ida.serviceProvider() == msg.sender, "Only the service provider can make a report.");
        bytes32 ID = keccak256(abi.encodePacked(_ida, _key, msg.sender));
        Report storage report = reports[ID];
        require(report.status == Status.None, "The report for this impact promise has already been created.");
        report.ida = _ida;
        report.key = _key;
        report.lastActionTime = now;
        report.status = Status.Created;
        report.outcome = _outcome;

        emit ReportCreated(address(_ida), _key, ID);
    }

    /** @dev Challenge the report made by the service provider. Accept enough ETH to cover the deposit, reimburse the rest.
     *  @param _ID The ID of the report.
     *  @param _evidence A link to an evidence using its URI. Ignored if not provided.
     */
    function challengeReport(bytes32 _ID, string calldata _evidence) external payable {
        Report storage report = reports[_ID];
        require(report.status == Status.Created, "The report should be in Created status.");
        require(now - report.lastActionTime <= executionTimeout, "Time to challenge the report has passed.");

        report.challenger = msg.sender;
        report.status = Status.Challenged;
        Round storage round = report.rounds[report.rounds.length++];

        uint arbitrationCost = arbitrator.arbitrationCost(arbitratorExtraData);
        uint totalCost = arbitrationCost.addCap((arbitrationCost.mulCap(sharedStakeMultiplier)) / MULTIPLIER_DIVISOR).addCap(baseDeposit);
        contribute(round, Party.Challenger, msg.sender, msg.value, totalCost);
        require(round.paidFees[uint(Party.Challenger)] >= totalCost, "You must fully fund your side.");
        round.hasPaid[uint(Party.Challenger)] = true;

        report.lastActionTime = now;

        if (bytes(_evidence).length > 0)
            emit Evidence(arbitrator, uint(_ID), msg.sender, _evidence);
    }

    /** @dev Confirm the correctness of the report made by the service provider. Accept enough ETH to cover the deposit, reimburse the rest.
     *  @param _ID The ID of the report.
     *  @param _evidence A link to an evidence using its URI. Ignored if not provided.
     */
    function confirmReport(bytes32 _ID, string calldata _evidence) external payable {
        Report storage report = reports[_ID];
        require(report.status == Status.Challenged, "The report should be in Challenged status.");
        require(now - report.lastActionTime <= executionTimeout, "Time to confirm the report has passed.");

        report.supporter = msg.sender;
        Round storage round = report.rounds[report.rounds.length - 1];

        uint arbitrationCost = arbitrator.arbitrationCost(arbitratorExtraData);
        uint totalCost = arbitrationCost.addCap((arbitrationCost.mulCap(sharedStakeMultiplier)) / MULTIPLIER_DIVISOR).addCap(baseDeposit);
        contribute(round, Party.Supporter, msg.sender, msg.value, totalCost);
        require(round.paidFees[uint(Party.Supporter)] >= totalCost, "You must fully fund your side.");
        round.hasPaid[uint(Party.Supporter)] = true;

        report.disputeID = arbitrator.createDispute.value(arbitrationCost)(RULING_OPTIONS, arbitratorExtraData);
        disputeIDToReportID[report.disputeID] = _ID;
        report.status = Status.Disputed;
        report.rounds.length++;
        round.feeRewards = round.feeRewards.subCap(arbitrationCost);

        emit Dispute(arbitrator, report.disputeID, 0, uint(_ID));

        if (bytes(_evidence).length > 0)
            emit Evidence(arbitrator, uint(_ID), msg.sender, _evidence);
    }

    /** @dev Approve the report either as correct, if it wasn't challenged, or as incorrect, if it was challenged but not confirmed within the timeout.
     *  Note that if the report is considered incorrect its outcome is inverted.
     *  @param _ID The ID of the report.
     */
    function approveReport(bytes32 _ID) external {
        Report storage report = reports[_ID];
        require(now - report.lastActionTime > executionTimeout, "The timeout has not passed yet.");
        require(report.status == Status.Created || report.status == Status.Challenged, "The report should be either in Created or Challenged status.");
        if (report.status == Status.Challenged) {
            if (report.outcome == Outcome.FAILURE)
                report.outcome = Outcome.SUCCESS;
            else
                report.outcome = Outcome.FAILURE;
        }

        report.status = Status.Resolved;
    }

    /** @dev Validate the promise that is proven fullfilled.
     *  Note that most of necessary checks for this function are done in IDA's contract.
     *  @param _ID The ID of the report.
     */
    function validate(bytes32 _ID) external {
        Report storage report = reports[_ID];
        require(report.status == Status.Resolved, "The report has not been resolved yet.");
        require(report.outcome == Outcome.SUCCESS, "Can't validate unsuccessful report.");
        report.ida.validatePromise(report.key);
    }

    /** @dev Take up to the total amount required to fund a side of an appeal. Reimburse the rest. Create an appeal if both sides are fully funded.
     *  @param _ID The ID of the report.
     *  @param _side The recipient of the contribution.
     */
    function fundAppeal(bytes32 _ID, Party _side) external payable {
        require(_side == Party.Supporter || _side == Party.Challenger, "Invalid party.");
        Report storage report = reports[_ID];
        require(report.status == Status.Disputed, "The report must have a pending dispute.");
        (uint appealPeriodStart, uint appealPeriodEnd) = arbitrator.appealPeriod(report.disputeID);
        require(now >= appealPeriodStart && now < appealPeriodEnd, "Contributions must be made within the appeal period.");

        uint multiplier;
        Party winner = Party(arbitrator.currentRuling(report.disputeID));
        Party loser;
        if (winner == Party.Supporter)
            loser = Party.Challenger;
        else if (winner == Party.Challenger)
            loser = Party.Supporter;
        require(_side!=loser || (now-appealPeriodStart < (appealPeriodEnd-appealPeriodStart)/2), "The loser must contribute during the first half of the appeal period.");

        if (_side == winner)
            multiplier = winnerStakeMultiplier;
        else if (_side == loser)
            multiplier = loserStakeMultiplier;
        else
            multiplier = sharedStakeMultiplier;

        Round storage round = report.rounds[report.rounds.length - 1];
        uint appealCost = arbitrator.appealCost(report.disputeID, arbitratorExtraData);
        uint totalCost = appealCost.addCap((appealCost.mulCap(multiplier)) / MULTIPLIER_DIVISOR);
        contribute(round, _side, msg.sender, msg.value, totalCost);

        if (round.paidFees[uint(_side)] >= totalCost) {
            round.hasPaid[uint(_side)] = true;
        }

        // Raise appeal if both sides are fully funded.
        if (round.hasPaid[uint(Party.Challenger)] && round.hasPaid[uint(Party.Supporter)]) {
            arbitrator.appeal.value(appealCost)(report.disputeID, arbitratorExtraData);
            report.rounds.length++;
            round.feeRewards = round.feeRewards.subCap(appealCost);
        }
    }

    /** @dev Reimburse contributions if no disputes were raised. If a dispute was raised, send the fee stake rewards and reimbursements proportionally to the contributions made to the winner of a dispute.
     *  @param _beneficiary The address that made contributions.
     *  @param _ID The ID of the report.
     *  @param _round The round from which to withdraw.
     */
    function withdrawFeesAndRewards(address payable _beneficiary, bytes32 _ID, uint _round) external {
        Report storage report = reports[_ID];
        Round storage round = report.rounds[_round];
        require(report.status == Status.Resolved, "The report must be resolved.");

        uint reward;
        if (!round.hasPaid[uint(Party.Supporter)] || !round.hasPaid[uint(Party.Challenger)]) {
            // Reimburse if not enough fees were raised to appeal the ruling.
            reward = round.contributions[_beneficiary][uint(Party.Supporter)] + round.contributions[_beneficiary][uint(Party.Challenger)];
        } else if (report.ruling == Party.None) {
            // Reimburse unspent fees proportionally if there is no winner or loser.
            uint rewardSupporter = round.paidFees[uint(Party.Supporter)] > 0
                ? (round.contributions[_beneficiary][uint(Party.Supporter)] * round.feeRewards) / (round.paidFees[uint(Party.Challenger)] + round.paidFees[uint(Party.Supporter)])
                : 0;
            uint rewardChallenger = round.paidFees[uint(Party.Challenger)] > 0
                ? (round.contributions[_beneficiary][uint(Party.Challenger)] * round.feeRewards) / (round.paidFees[uint(Party.Challenger)] + round.paidFees[uint(Party.Supporter)])
                : 0;

            reward = rewardSupporter + rewardChallenger;
        } else {
            // Reward the winner.
            reward = round.paidFees[uint(report.ruling)] > 0
                ? (round.contributions[_beneficiary][uint(report.ruling)] * round.feeRewards) / round.paidFees[uint(report.ruling)]
                : 0;

        }
        round.contributions[_beneficiary][uint(Party.Supporter)] = 0;
        round.contributions[_beneficiary][uint(Party.Challenger)] = 0;

        _beneficiary.send(reward);
    }

    /** @dev Give a ruling for a dispute. Can only be called by the arbitrator. TRUSTED.
     *  Account for the situation where the winner loses a case due to paying less appeal fees than expected.
     *  @param _disputeID ID of the dispute in the arbitrator contract.
     *  @param _ruling Ruling given by the arbitrator. Note that 0 is reserved for "Refused to arbitrate".
     */
    function rule(uint _disputeID, uint _ruling) public {
        Party resultRuling = Party(_ruling);
        bytes32 ID = disputeIDToReportID[_disputeID];
        Report storage report = reports[ID];

        Round storage round = report.rounds[report.rounds.length - 1];
        require(_ruling <= RULING_OPTIONS, "Invalid ruling option");
        require(address(arbitrator) == msg.sender, "Only the arbitrator can give a ruling");
        require(report.status == Status.Disputed, "The report must be in Disputed status.");

        // The ruling is inverted if the loser paid its fees.
        if (round.hasPaid[uint(Party.Supporter)] == true) // If one side paid its fees, the ruling is in its favor. Note that if the other side had also paid, an appeal would have been created.
            resultRuling = Party.Supporter;
        else if (round.hasPaid[uint(Party.Challenger)] == true)
            resultRuling = Party.Challenger;

        emit Ruling(IArbitrator(msg.sender), _disputeID, uint(resultRuling));
        executeRuling(_disputeID, uint(resultRuling));
    }

    /** @dev Submit a reference to evidence. EVENT.
     *  @param _ID The ID of the report the evidence was submitted for.
     *  @param _evidenceURI A link to an evidence using its URI.
     */
    function submitEvidence(bytes32 _ID, string calldata _evidenceURI) external {
        Report storage report = reports[_ID];
        require(report.status > Status.None && report.status < Status.Resolved, "The report should exist and not be resolved.");

        emit Evidence(arbitrator, uint(_ID), msg.sender, _evidenceURI);
    }

    /* Internal */

    /** @dev Return the contribution value and remainder from available ETH and required amount.
     *  @param _available The amount of ETH available for the contribution.
     *  @param _requiredAmount The amount of ETH required for the contribution.
     *  @return taken The amount of ETH taken.
     *  @return remainder The amount of ETH left from the contribution.
     */
    function calculateContribution(uint _available, uint _requiredAmount)
        internal
        pure
        returns(uint taken, uint remainder)
    {
        if (_requiredAmount > _available)
            return (_available, 0); // Take whatever is available, return 0 as leftover ETH.
        else
            return (_requiredAmount, _available - _requiredAmount);
    }

    /** @dev Make a fee contribution.
     *  @param _round The round to contribute.
     *  @param _side The side for which to contribute.
     *  @param _contributor The contributor.
     *  @param _amount The amount contributed.
     *  @param _totalRequired The total amount required for this side.
     *  @return The amount of appeal fees contributed.
     */
    function contribute(Round storage _round, Party _side, address payable _contributor, uint _amount, uint _totalRequired) internal returns (uint) {
        // Take up to the amount necessary to fund the current round at the current costs.
        uint contribution; // Amount contributed.
        uint remainingETH; // Remaining ETH to send back.
        (contribution, remainingETH) = calculateContribution(_amount, _totalRequired.subCap(_round.paidFees[uint(_side)]));
        _round.contributions[_contributor][uint(_side)] += contribution;
        _round.paidFees[uint(_side)] += contribution;
        _round.feeRewards += contribution;

        // Reimburse leftover ETH.
        _contributor.send(remainingETH); // Deliberate use of send in order to not block the contract in case of reverting fallback.

        return contribution;
    }

    /** @dev Execute the ruling of a dispute.
     *  @param _disputeID ID of the dispute in the arbitrator contract.
     *  @param _ruling Ruling given by the arbitrator. Note that 0 is reserved for "Refused to arbitrate".
     */
    function executeRuling(uint _disputeID, uint _ruling) internal {
        bytes32 ID = disputeIDToReportID[_disputeID];
        Report storage report = reports[ID];

        Party winner = Party(_ruling);

        if (winner == Party.Challenger) {
            if (report.outcome == Outcome.SUCCESS)
                report.outcome = Outcome.FAILURE;
            else
                report.outcome = Outcome.SUCCESS;
        } else if (winner == Party.None) {
            report.outcome = Outcome.FAILURE; // Don't validate the report in case of unconclusive ruling.
        }

        report.status = Status.Resolved;
        report.ruling = Party(_ruling);
    }

    // ************************ //
    // *       Getters        * //
    // ************************ //

    /** @dev Get the contributions made by a party for a given round of a report.
     *  @param _ID The ID of the report.
     *  @param _round The round to query.
     *  @param _contributor The address of the contributor.
     *  @return The contributions.
     */
    function getContributions(
        bytes32 _ID,
        uint _round,
        address _contributor
    ) external view returns(uint[3] memory contributions) {
        Report storage report = reports[_ID];
        Round storage round = report.rounds[_round];
        contributions = round.contributions[_contributor];
    }

    /** @dev Gets the information of a round of a report.
     *  @param _ID The ID of the queried report.
     *  @param _round The round to query.
     *  @return The round information.
     */
    function getRoundInfo(bytes32 _ID, uint _round)
        external
        view
        returns (
            bool appealed,
            uint[3] memory paidFees,
            bool[3] memory hasPaid,
            uint feeRewards
        )
    {
        Report storage report = reports[_ID];
        Round storage round = report.rounds[_round];
        return (
            _round != (report.rounds.length - 1),
            round.paidFees,
            round.hasPaid,
            round.feeRewards
        );
    }
}