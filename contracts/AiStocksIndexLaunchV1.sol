// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IERC20MetadataMinimal is IERC20Minimal {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

library SafeTransferLibV1 {
    error TransferFailed();
    error TransferFromFailed();
    error ApproveFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFromFailed();
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }
}

abstract contract OwnedV1 {
    error NotOwner();
    error ZeroAddress();
    address public owner;
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

abstract contract ReentrancyGuardV1 {
    uint256 private _lock = 1;
    error Reentrancy();
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }
}

interface IStockEligibilityV1 {
    function canUseStockIndex(address wallet) external view returns (bool);
}

contract AiStocksIndexTokenV1 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public controller;
    address public immutable policyManager;
    bool public immutable restrictedTransfers;
    bool public controllerFinalized;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event ControllerFinalized(address indexed controller);

    error NotController();
    error ControllerAlreadyFinalized();
    error InvalidController();
    error InsufficientBalance();
    error InsufficientAllowance();
    error NotEligible();

    constructor(string memory tokenName, string memory tokenSymbol, address initialController, address policyManager_, bool restrictedTransfers_) {
        name = tokenName;
        symbol = tokenSymbol;
        controller = initialController;
        policyManager = policyManager_;
        restrictedTransfers = restrictedTransfers_;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function finalizeController(address newController) external {
        if (msg.sender != controller) revert NotController();
        if (controllerFinalized) revert ControllerAlreadyFinalized();
        if (newController == address(0)) revert InvalidController();
        controller = newController;
        controllerFinalized = true;
        emit ControllerFinalized(newController);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != controller) revert NotController();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != controller) revert NotController();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidController();
        if (restrictedTransfers) {
            IStockEligibilityV1 policy = IStockEligibilityV1(policyManager);
            if (!policy.canUseStockIndex(from) || !policy.canUseStockIndex(to)) revert NotEligible();
        }
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}

contract AiStocksAssetRegistryV1 is OwnedV1 {
    enum AssetClass { UNKNOWN, CASH, BASE_ASSET, B20_STOCK }

    struct AssetConfig {
        AssetClass assetClass;
        bool verified;
        bool blocked;
        uint16 maxWeightBps;
    }

    mapping(address => AssetConfig) public assets;
    event AssetConfigured(address indexed token, AssetClass indexed assetClass, bool verified, bool blocked, uint16 maxWeightBps);

    constructor(address initialOwner) OwnedV1(initialOwner) {}

    function configureAsset(address token, AssetClass assetClass, bool verified, bool blocked, uint16 maxWeightBps) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (maxWeightBps > 10_000) maxWeightBps = 10_000;
        assets[token] = AssetConfig(assetClass, verified, blocked, maxWeightBps);
        emit AssetConfigured(token, assetClass, verified, blocked, maxWeightBps);
    }

    function configureAssets(
        address[] calldata tokens,
        AssetClass[] calldata classes,
        bool[] calldata verified,
        bool[] calldata blocked,
        uint16[] calldata maxWeights
    ) external onlyOwner {
        uint256 n = tokens.length;
        require(classes.length == n && verified.length == n && blocked.length == n && maxWeights.length == n, "LENGTH");
        for (uint256 i; i < n; ++i) {
            uint16 cap = maxWeights[i] > 10_000 ? 10_000 : maxWeights[i];
            assets[tokens[i]] = AssetConfig(classes[i], verified[i], blocked[i], cap);
            emit AssetConfigured(tokens[i], classes[i], verified[i], blocked[i], cap);
        }
    }

    function classOf(address token) external view returns (AssetClass) { return assets[token].assetClass; }
    function isBlocked(address token) external view returns (bool) { return assets[token].blocked; }
}

contract AiStocksPolicyManagerV1 is OwnedV1 {
    mapping(address => bool) public stockEligibleWallet;
    mapping(address => bool) public systemAddress;
    address public eligibilityProvider;

    event WalletEligibilitySet(address indexed wallet, bool eligible);
    event SystemAddressSet(address indexed account, bool allowed);
    event EligibilityProviderSet(address indexed provider);

    constructor(address initialOwner) OwnedV1(initialOwner) {}

    function setWalletEligibility(address wallet, bool eligible) external onlyOwner {
        stockEligibleWallet[wallet] = eligible;
        emit WalletEligibilitySet(wallet, eligible);
    }

    function setWalletEligibilityBatch(address[] calldata wallets, bool eligible) external onlyOwner {
        for (uint256 i; i < wallets.length; ++i) {
            stockEligibleWallet[wallets[i]] = eligible;
            emit WalletEligibilitySet(wallets[i], eligible);
        }
    }

    function setSystemAddress(address account, bool allowed) external onlyOwner {
        systemAddress[account] = allowed;
        emit SystemAddressSet(account, allowed);
    }

    function setEligibilityProvider(address provider) external onlyOwner {
        eligibilityProvider = provider;
        emit EligibilityProviderSet(provider);
    }

    function canUseStockIndex(address wallet) public view returns (bool) {
        if (systemAddress[wallet] || stockEligibleWallet[wallet]) return true;
        address provider = eligibilityProvider;
        if (provider == address(0)) return false;
        (bool ok, bytes memory data) = provider.staticcall(abi.encodeWithSignature("isEligible(address)", wallet));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }
}

interface IAiStocksFactoryViewV1 {
    function isIndexVault(address vault) external view returns (bool);
    function creatorOf(address vault) external view returns (address);
    function hasStock(address vault) external view returns (bool);
}

contract AiStocksIndexVaultV1 is ReentrancyGuardV1 {
    using SafeTransferLibV1 for address;

    address public immutable factory;
    AiStocksIndexTokenV1 public immutable shareToken;
    address public mintRouter;
    address public redeemRouter;
    address public immutable policyManager;
    address public creator;
    bool public immutable containsStock;
    bool public routersFinalized;

    address[] private _assets;
    uint16[] private _targetWeightsBps;
    mapping(address => bool) public isAsset;
    mapping(address => uint256) public accountedBalance;

    event RoutersFinalized(address indexed mintRouter, address indexed redeemRouter);
    event DepositFinalized(address indexed recipient, uint256 sharesMinted);
    event Redeemed(address indexed owner, address indexed receiver, uint256 sharesBurned);

    error NotFactory();
    error NotMintRouter();
    error RoutersAlreadyFinalized();
    error InvalidAssets();
    error ZeroShares();
    error InsufficientDeposit();
    error Slippage();

    constructor(
        address factory_,
        address shareToken_,
        address creator_,
        address policyManager_,
        address[] memory assets_,
        uint16[] memory weights_,
        bool containsStock_
    ) {
        if (assets_.length < 2 || assets_.length != weights_.length) revert InvalidAssets();
        factory = factory_;
        shareToken = AiStocksIndexTokenV1(shareToken_);
        creator = creator_;
        policyManager = policyManager_;
        containsStock = containsStock_;
        uint256 totalWeight;
        for (uint256 i; i < assets_.length; ++i) {
            if (assets_[i] == address(0) || isAsset[assets_[i]]) revert InvalidAssets();
            isAsset[assets_[i]] = true;
            _assets.push(assets_[i]);
            _targetWeightsBps.push(weights_[i]);
            totalWeight += weights_[i];
        }
        if (totalWeight != 10_000) revert InvalidAssets();
    }

    function finalizeRouters(address mintRouter_, address redeemRouter_) external {
        if (msg.sender != factory) revert NotFactory();
        if (routersFinalized) revert RoutersAlreadyFinalized();
        if (mintRouter_ == address(0) || redeemRouter_ == address(0)) revert NotMintRouter();
        mintRouter = mintRouter_;
        redeemRouter = redeemRouter_;
        routersFinalized = true;
        emit RoutersFinalized(mintRouter_, redeemRouter_);
    }

    function assetCount() external view returns (uint256) { return _assets.length; }
    function assetAt(uint256 i) external view returns (address) { return _assets[i]; }
    function targetWeightAt(uint256 i) external view returns (uint16) { return _targetWeightsBps[i]; }
    function assets() external view returns (address[] memory) { return _assets; }
    function targetWeightsBps() external view returns (uint16[] memory) { return _targetWeightsBps; }

    // Deposits after launch mint the minimum pro-rata share represented by every
    // underlying asset received. This avoids needing an onchain price oracle and
    // prevents new deposits from diluting existing holders when the basket moves.
    function finalizeDeposit(address recipient, uint256 initialSharesHint, uint256 minSharesOut)
        external nonReentrant returns (uint256 sharesOut)
    {
        if (msg.sender != mintRouter) revert NotMintRouter();
        uint256 supply = shareToken.totalSupply();
        uint256 n = _assets.length;
        uint256[] memory current = new uint256[](n);
        uint256[] memory deposits = new uint256[](n);

        for (uint256 i; i < n; ++i) {
            address token = _assets[i];
            uint256 bal = IERC20Minimal(token).balanceOf(address(this));
            uint256 accounted = accountedBalance[token];
            if (bal < accounted) revert InsufficientDeposit();
            current[i] = bal;
            deposits[i] = bal - accounted;
            if (deposits[i] == 0) revert InsufficientDeposit();
        }

        if (supply == 0) {
            sharesOut = initialSharesHint;
            if (sharesOut == 0) revert ZeroShares();
        } else {
            sharesOut = type(uint256).max;
            for (uint256 i; i < n; ++i) {
                uint256 oldBal = accountedBalance[_assets[i]];
                if (oldBal == 0) revert InsufficientDeposit();
                uint256 candidate = deposits[i] * supply / oldBal;
                if (candidate < sharesOut) sharesOut = candidate;
            }
            if (sharesOut == 0 || sharesOut == type(uint256).max) revert ZeroShares();

            // Refund any over-bought amount so the accepted deposit is exactly
            // proportional to the pre-deposit basket.
            for (uint256 i; i < n; ++i) {
                address token = _assets[i];
                uint256 oldBal = accountedBalance[token];
                uint256 required = (oldBal * sharesOut + supply - 1) / supply;
                uint256 excess = deposits[i] > required ? deposits[i] - required : 0;
                if (excess != 0) token.safeTransfer(recipient, excess);
            }
        }

        if (sharesOut < minSharesOut) revert Slippage();
        shareToken.mint(recipient, sharesOut);
        for (uint256 i; i < n; ++i) {
            address token = _assets[i];
            accountedBalance[token] = IERC20Minimal(token).balanceOf(address(this));
        }
        emit DepositFinalized(recipient, sharesOut);
    }

    function redeem(uint256 shares, address receiver) external nonReentrant returns (uint256[] memory amounts) {
        if (containsStock && !IStockEligibilityV1(policyManager).canUseStockIndex(msg.sender)) revert Slippage();
        amounts = _redeem(msg.sender, msg.sender, shares, receiver);
    }

    function redeemFor(address owner, uint256 shares, address receiver) external nonReentrant returns (uint256[] memory amounts) {
        if (msg.sender != redeemRouter) revert NotMintRouter();
        if (containsStock && !IStockEligibilityV1(policyManager).canUseStockIndex(owner)) revert Slippage();
        amounts = _redeem(owner, msg.sender, shares, receiver);
    }

    function _redeem(address eventOwner, address burnFrom, uint256 shares, address receiver) internal returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroShares();
        uint256 supply = shareToken.totalSupply();
        if (shares > supply) revert ZeroShares();
        shareToken.burn(burnFrom, shares);
        uint256 n = _assets.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address token = _assets[i];
            uint256 bal = IERC20Minimal(token).balanceOf(address(this));
            uint256 amount = bal * shares / supply;
            amounts[i] = amount;
            if (amount != 0) token.safeTransfer(receiver, amount);
            accountedBalance[token] = IERC20Minimal(token).balanceOf(address(this));
        }
        emit Redeemed(eventOwner, receiver, shares);
    }
}

contract AiStocksIndexFactoryV1 is OwnedV1 {
    enum AssetClass { UNKNOWN, CASH, BASE_ASSET, B20_STOCK }

    AiStocksAssetRegistryV1 public immutable registry;
    AiStocksPolicyManagerV1 public immutable policyManager;
    address public mintRouter;
    address public redeemRouter;
    address payable public launchFeeRecipient;
    uint256 public launchFeeWei;

    uint16 public constant MIN_WEIGHT_BPS = 500;
    uint16 public constant MAX_WEIGHT_BPS = 6000;
    uint16 public constant MAX_CUSTOM_WEIGHT_BPS = 3500;
    uint8 public constant MAX_CUSTOM_ASSETS = 4;
    uint8 public constant MIN_ASSETS = 2;
    uint8 public constant MAX_ASSETS = 10;

    mapping(address => bool) public isIndexVault;
    mapping(address => address) public creatorOf;
    mapping(address => bool) public hasStock;
    address[] public allVaults;

    event RoutersSet(address indexed mintRouter, address indexed redeemRouter);
    event LaunchFeeUpdated(uint256 previousFeeWei, uint256 newFeeWei);
    event LaunchFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event LaunchFeePaid(address indexed creator, address indexed recipient, uint256 amount);
    event IndexLaunched(
        address indexed creator,
        address indexed vault,
        address indexed token,
        string name,
        string symbol,
        bool containsStock,
        address[] assets,
        uint16[] weightsBps
    );

    error InvalidComposition();
    error BlockedAsset(address token);
    error InvalidToken(address token);
    error MintRouterNotSet();
    error InvalidLaunchFee();
    error IncorrectLaunchFee(uint256 required, uint256 supplied);
    error LaunchFeeTransferFailed();

    constructor(
        address initialOwner,
        address registry_,
        address policyManager_,
        address payable launchFeeRecipient_,
        uint256 launchFeeWei_
    ) OwnedV1(initialOwner) {
        if (launchFeeRecipient_ == address(0)) revert ZeroAddress();
        if (launchFeeWei_ == 0) revert InvalidLaunchFee();
        registry = AiStocksAssetRegistryV1(registry_);
        policyManager = AiStocksPolicyManagerV1(policyManager_);
        launchFeeRecipient = launchFeeRecipient_;
        launchFeeWei = launchFeeWei_;
    }

    function setRouters(address mintRouter_, address redeemRouter_) external onlyOwner {
        if (mintRouter_ == address(0) || redeemRouter_ == address(0)) revert ZeroAddress();
        mintRouter = mintRouter_;
        redeemRouter = redeemRouter_;
        emit RoutersSet(mintRouter_, redeemRouter_);
    }

    function setLaunchFee(uint256 newFeeWei) external onlyOwner {
        if (newFeeWei == 0) revert InvalidLaunchFee();
        uint256 previous = launchFeeWei;
        launchFeeWei = newFeeWei;
        emit LaunchFeeUpdated(previous, newFeeWei);
    }

    function setLaunchFeeRecipient(address payable newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address previous = launchFeeRecipient;
        launchFeeRecipient = newRecipient;
        emit LaunchFeeRecipientUpdated(previous, newRecipient);
    }

    function vaultCount() external view returns (uint256) { return allVaults.length; }

    function launchIndex(string calldata name, string calldata symbol, address[] calldata assets_, uint16[] calldata weights_)
        external payable returns (address vaultAddress, address tokenAddress)
    {
        uint256 requiredFee = launchFeeWei;
        if (msg.value != requiredFee) revert IncorrectLaunchFee(requiredFee, msg.value);
        address router = mintRouter;
        address redeem = redeemRouter;
        if (router == address(0) || redeem == address(0)) revert MintRouterNotSet();
        uint256 n = assets_.length;
        if (n < MIN_ASSETS || n > MAX_ASSETS || weights_.length != n) revert InvalidComposition();
        if (bytes(name).length < 3 || bytes(name).length > 64 || bytes(symbol).length < 2 || bytes(symbol).length > 12) revert InvalidComposition();

        uint256 totalWeight;
        uint256 customCount;
        bool stock;

        for (uint256 i; i < n; ++i) {
            address token = assets_[i];
            if (token == address(0)) revert InvalidToken(token);
            for (uint256 j; j < i; ++j) if (assets_[j] == token) revert InvalidComposition();

            (AiStocksAssetRegistryV1.AssetClass cls, , bool blocked, uint16 registryCap) = registry.assets(token);
            if (blocked) revert BlockedAsset(token);
            uint16 weight = weights_[i];
            if (weight < MIN_WEIGHT_BPS || weight > MAX_WEIGHT_BPS) revert InvalidComposition();
            if (registryCap != 0 && weight > registryCap) revert InvalidComposition();

            if (cls == AiStocksAssetRegistryV1.AssetClass.UNKNOWN) {
                ++customCount;
                if (weight > MAX_CUSTOM_WEIGHT_BPS) revert InvalidComposition();
                _validateErc20(token);
                // Unknown tokens that expose the B20 uiMultiplier interface are
                // conservatively treated as stock-like so a newly issued stock
                // cannot bypass the stock policy before the registry is updated.
                if (_looksLikeB20(token)) stock = true;
            }
            if (cls == AiStocksAssetRegistryV1.AssetClass.B20_STOCK) stock = true;
            totalWeight += weight;
        }
        if (totalWeight != 10_000 || customCount > MAX_CUSTOM_ASSETS) revert InvalidComposition();

        AiStocksIndexTokenV1 tokenContract = new AiStocksIndexTokenV1(name, symbol, address(this), address(policyManager), stock);
        AiStocksIndexVaultV1 vault = new AiStocksIndexVaultV1(
            address(this), address(tokenContract), msg.sender, address(policyManager), assets_, weights_, stock
        );
        tokenContract.finalizeController(address(vault));
        vault.finalizeRouters(router, redeem);

        vaultAddress = address(vault);
        tokenAddress = address(tokenContract);
        isIndexVault[vaultAddress] = true;
        creatorOf[vaultAddress] = msg.sender;
        hasStock[vaultAddress] = stock;
        allVaults.push(vaultAddress);

        address payable recipient = launchFeeRecipient;
        (bool feeSent, ) = recipient.call{value: requiredFee}("");
        if (!feeSent) revert LaunchFeeTransferFailed();
        emit LaunchFeePaid(msg.sender, recipient, requiredFee);
        emit IndexLaunched(msg.sender, vaultAddress, tokenAddress, name, symbol, stock, assets_, weights_);
    }

    function _looksLikeB20(address token) private view returns (bool) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("uiMultiplier()"));
        return ok && data.length >= 32 && abi.decode(data, (uint256)) > 0;
    }

    function _validateErc20(address token) private view {
        if (token.code.length == 0) revert InvalidToken(token);
        (bool ok1, bytes memory d1) = token.staticcall(abi.encodeWithSignature("decimals()"));
        (bool ok2, bytes memory d2) = token.staticcall(abi.encodeWithSignature("symbol()"));
        if (!ok1 || d1.length < 32 || !ok2 || d2.length == 0) revert InvalidToken(token);
        uint256 dec = abi.decode(d1, (uint256));
        if (dec > 18) revert InvalidToken(token);
    }
}

contract AiStocksIndexMintRouterV1 is OwnedV1, ReentrancyGuardV1 {
    using SafeTransferLibV1 for address;

    struct SwapLeg {
        address asset;
        address target;
        address spender;
        uint256 usdcAmount;
        bytes data;
    }

    address public immutable USDC;
    AiStocksIndexFactoryV1 public immutable factory;
    AiStocksPolicyManagerV1 public immutable policyManager;
    address public protocolFeeRecipient;
    uint16 public protocolFeeBps = 30;
    uint16 public creatorFeeBps = 20;

    mapping(address => bool) public allowedTargets;
    mapping(address => bool) public allowedSpenders;

    event TargetAllowed(address indexed target, bool allowed);
    event SpenderAllowed(address indexed spender, bool allowed);
    event FeesUpdated(uint16 protocolFeeBps, uint16 creatorFeeBps, address indexed recipient);
    event IndexMinted(address indexed user, address indexed vault, uint256 grossUsdc, uint256 sharesOut);

    error UnsupportedVault();
    error NotEligible();
    error InvalidLegs();
    error RouteNotAllowed();
    error SwapFailed(bytes reason);
    error FeeTooHigh();

    constructor(address initialOwner, address usdc, address factory_, address policyManager_, address feeRecipient) OwnedV1(initialOwner) {
        if (usdc == address(0) || factory_ == address(0) || policyManager_ == address(0) || feeRecipient == address(0)) revert ZeroAddress();
        USDC = usdc;
        factory = AiStocksIndexFactoryV1(factory_);
        policyManager = AiStocksPolicyManagerV1(policyManager_);
        protocolFeeRecipient = feeRecipient;
    }

    function setTargetAllowed(address target, bool allowed) external onlyOwner { allowedTargets[target] = allowed; emit TargetAllowed(target, allowed); }
    function setSpenderAllowed(address spender, bool allowed) external onlyOwner { allowedSpenders[spender] = allowed; emit SpenderAllowed(spender, allowed); }

    function setFees(uint16 protocolBps, uint16 creatorBps, address recipient) external onlyOwner {
        if (protocolBps + creatorBps > 200 || recipient == address(0)) revert FeeTooHigh();
        protocolFeeBps = protocolBps;
        creatorFeeBps = creatorBps;
        protocolFeeRecipient = recipient;
        emit FeesUpdated(protocolBps, creatorBps, recipient);
    }

    function executeMint(address vaultAddress, uint256 grossUsdc, SwapLeg[] calldata legs, uint256 minSharesOut)
        external nonReentrant returns (uint256 sharesOut)
    {
        if (!factory.isIndexVault(vaultAddress)) revert UnsupportedVault();
        if (factory.hasStock(vaultAddress) && !policyManager.canUseStockIndex(msg.sender)) revert NotEligible();
        if (grossUsdc == 0) revert InvalidLegs();

        AiStocksIndexVaultV1 vault = AiStocksIndexVaultV1(vaultAddress);
        uint256 n = vault.assetCount();
        if (legs.length != n) revert InvalidLegs();

        uint256 usdcBefore = IERC20Minimal(USDC).balanceOf(address(this));
        uint256 protocolFee = grossUsdc * protocolFeeBps / 10_000;
        uint256 creatorFee = grossUsdc * creatorFeeBps / 10_000;
        uint256 netUsdc = grossUsdc - protocolFee - creatorFee;
        USDC.safeTransferFrom(msg.sender, address(this), grossUsdc);
        if (protocolFee != 0) USDC.safeTransfer(protocolFeeRecipient, protocolFee);
        if (creatorFee != 0) USDC.safeTransfer(factory.creatorOf(vaultAddress), creatorFee);

        bool firstDeposit = vault.shareToken().totalSupply() == 0;
        uint256 assigned;
        for (uint256 i; i < legs.length; ++i) {
            SwapLeg calldata leg = legs[i];
            if (!vault.isAsset(leg.asset) || leg.usdcAmount == 0) revert InvalidLegs();
            for (uint256 j; j < i; ++j) if (legs[j].asset == leg.asset) revert InvalidLegs();

            if (firstDeposit) {
                uint16 targetWeight;
                bool found;
                for (uint256 k; k < n; ++k) {
                    if (vault.assetAt(k) == leg.asset) {
                        targetWeight = vault.targetWeightAt(k);
                        found = true;
                        break;
                    }
                }
                if (!found) revert InvalidLegs();
                uint256 expected = netUsdc * targetWeight / 10_000;
                uint256 delta = leg.usdcAmount > expected ? leg.usdcAmount - expected : expected - leg.usdcAmount;
                // Rounding remainder across at most ten legs is only a few USDC base units.
                if (delta > 20) revert InvalidLegs();
            }

            assigned += leg.usdcAmount;

            if (leg.asset == USDC) {
                if (leg.target != address(0) || leg.spender != address(0) || leg.data.length != 0) revert InvalidLegs();
                USDC.safeTransfer(vaultAddress, leg.usdcAmount);
            } else {
                if (!allowedTargets[leg.target] || !allowedSpenders[leg.spender]) revert RouteNotAllowed();
                USDC.safeApprove(leg.spender, 0);
                USDC.safeApprove(leg.spender, leg.usdcAmount);
                (bool ok, bytes memory reason) = leg.target.call(leg.data);
                USDC.safeApprove(leg.spender, 0);
                if (!ok) revert SwapFailed(reason);
            }
        }
        if (assigned != netUsdc) revert InvalidLegs();

        // Six-decimal USDC starts indexes at roughly $1.00 per 18-decimal share.
        uint256 initialSharesHint = netUsdc * 1e12;
        sharesOut = vault.finalizeDeposit(msg.sender, initialSharesHint, minSharesOut);

        uint256 afterUsdc = IERC20Minimal(USDC).balanceOf(address(this));
        uint256 dust = afterUsdc > usdcBefore ? afterUsdc - usdcBefore : 0;
        if (dust != 0) USDC.safeTransfer(msg.sender, dust);
        emit IndexMinted(msg.sender, vaultAddress, grossUsdc, sharesOut);
    }
}

contract AiStocksIndexRedeemRouterV1 is OwnedV1, ReentrancyGuardV1 {
    using SafeTransferLibV1 for address;

    struct SellLeg {
        address asset;
        address target;
        address spender;
        bytes data;
    }

    address public immutable USDC;
    AiStocksIndexFactoryV1 public immutable factory;
    AiStocksPolicyManagerV1 public immutable policyManager;
    address public protocolFeeRecipient;
    uint16 public protocolFeeBps = 30;
    uint16 public creatorFeeBps = 20;
    mapping(address => bool) public allowedTargets;
    mapping(address => bool) public allowedSpenders;

    event IndexRedeemed(address indexed user, address indexed vault, uint256 sharesBurned, uint256 usdcOut);
    event FeesUpdated(uint16 protocolFeeBps, uint16 creatorFeeBps, address indexed recipient);
    error UnsupportedVault();
    error NotEligible();
    error InvalidLegs();
    error RouteNotAllowed();
    error SwapFailed(bytes reason);
    error Slippage();
    error FeeTooHigh();

    constructor(address initialOwner, address usdc, address factory_, address policyManager_, address feeRecipient) OwnedV1(initialOwner) {
        if (usdc == address(0) || factory_ == address(0) || policyManager_ == address(0) || feeRecipient == address(0)) revert ZeroAddress();
        USDC = usdc;
        factory = AiStocksIndexFactoryV1(factory_);
        policyManager = AiStocksPolicyManagerV1(policyManager_);
        protocolFeeRecipient = feeRecipient;
    }

    function setTargetAllowed(address target, bool allowed) external onlyOwner { allowedTargets[target] = allowed; }
    function setSpenderAllowed(address spender, bool allowed) external onlyOwner { allowedSpenders[spender] = allowed; }
    function setFees(uint16 protocolBps, uint16 creatorBps, address recipient) external onlyOwner {
        if (protocolBps + creatorBps > 200 || recipient == address(0)) revert FeeTooHigh();
        protocolFeeBps = protocolBps; creatorFeeBps = creatorBps; protocolFeeRecipient = recipient;
        emit FeesUpdated(protocolBps, creatorBps, recipient);
    }

    function executeRedeem(address vaultAddress, uint256 shares, SellLeg[] calldata legs, uint256 minUsdcOut)
        external nonReentrant returns (uint256 usdcOut)
    {
        if (!factory.isIndexVault(vaultAddress)) revert UnsupportedVault();
        if (factory.hasStock(vaultAddress) && !policyManager.canUseStockIndex(msg.sender)) revert NotEligible();
        AiStocksIndexVaultV1 vault = AiStocksIndexVaultV1(vaultAddress);
        AiStocksIndexTokenV1 share = vault.shareToken();
        uint256 n = vault.assetCount();
        uint256 nonUsdc;
        for (uint256 i; i < n; ++i) if (vault.assetAt(i) != USDC) ++nonUsdc;
        if (legs.length != nonUsdc) revert InvalidLegs();

        uint256 usdcBefore = IERC20Minimal(USDC).balanceOf(address(this));
        address(share).safeTransferFrom(msg.sender, address(this), shares);
        vault.redeemFor(msg.sender, shares, address(this));

        for (uint256 i; i < legs.length; ++i) {
            SellLeg calldata leg = legs[i];
            if (leg.asset == USDC || !vault.isAsset(leg.asset)) revert InvalidLegs();
            for (uint256 j; j < i; ++j) if (legs[j].asset == leg.asset) revert InvalidLegs();
            if (!allowedTargets[leg.target] || !allowedSpenders[leg.spender]) revert RouteNotAllowed();
            uint256 amount = IERC20Minimal(leg.asset).balanceOf(address(this));
            if (amount == 0) revert InvalidLegs();
            leg.asset.safeApprove(leg.spender, 0);
            leg.asset.safeApprove(leg.spender, amount);
            (bool ok, bytes memory reason) = leg.target.call(leg.data);
            leg.asset.safeApprove(leg.spender, 0);
            if (!ok) revert SwapFailed(reason);
            uint256 residue = IERC20Minimal(leg.asset).balanceOf(address(this));
            if (residue != 0) leg.asset.safeTransfer(msg.sender, residue);
        }

        uint256 grossOut = IERC20Minimal(USDC).balanceOf(address(this)) - usdcBefore;
        uint256 protocolFee = grossOut * protocolFeeBps / 10_000;
        uint256 creatorFee = grossOut * creatorFeeBps / 10_000;
        usdcOut = grossOut - protocolFee - creatorFee;
        if (usdcOut < minUsdcOut) revert Slippage();
        if (protocolFee != 0) USDC.safeTransfer(protocolFeeRecipient, protocolFee);
        if (creatorFee != 0) USDC.safeTransfer(factory.creatorOf(vaultAddress), creatorFee);
        if (usdcOut != 0) USDC.safeTransfer(msg.sender, usdcOut);
        emit IndexRedeemed(msg.sender, vaultAddress, shares, usdcOut);
    }
}
