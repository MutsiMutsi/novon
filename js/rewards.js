function showRewardNotification(points, total, balanceMultiplier, nextTierMultiplier, nknToNextTier) {
  // Create container
  const notification = document.createElement('div');
  notification.className = 'reward-notification';

  // Create content bubble
  const bubble = document.createElement('div');
  bubble.className = 'reward-bubble';

  const pointsElem = document.createElement('span');
  pointsElem.className = 'reward-points';
  pointsElem.textContent = `+${points} points!`;

  const totalElem = document.createElement('span');
  totalElem.className = 'reward-total';
  totalElem.textContent = `Total: ${total} 🎉`;

  const multiplierElem = document.createElement('span');
  multiplierElem.className = 'reward-multiplier';
  multiplierElem.textContent = `🏅 Multiplier: x${balanceMultiplier.toFixed(2)}`;

  const nextTierElem = document.createElement('span');
  nextTierElem.className = 'reward-next-tier';
  nextTierElem.textContent = `🎯 Next Tier: x${nextTierMultiplier.toFixed(2)}`;

  const progressElem = document.createElement('span');
  progressElem.className = 'reward-progress';
  progressElem.textContent = `💰 +${nknToNextTier} NKN to level up!`;

  // Append elements
  bubble.appendChild(pointsElem);
  bubble.appendChild(totalElem);
  bubble.appendChild(multiplierElem);
  bubble.appendChild(nextTierElem);
  bubble.appendChild(progressElem);
  notification.appendChild(bubble);
  document.body.appendChild(notification);

  // Add coin pop animation
  for (let i = 0; i < 6; i++) {
    const coin = document.createElement('div');
    coin.className = 'coin';
    coin.style.left = `${40 + Math.random() * 20}px`;
    coin.style.top = `${10 + Math.random() * 10}px`;
    coin.style.animationDelay = `${i * 0.1}s`;
    bubble.appendChild(coin);
  }

  // Remove after animation completes
  setTimeout(() => {
    notification.remove();
  }, 4500);
}

let lastReward = undefined;

function setNextRewardProgress(progress)
{
  const fill = document.querySelector('.reward-banner-fill');
  // Clamp progress to 0–1
  progress = Math.min(1, Math.max(0, progress));
  fill.style.width = `${progress * 100}%`;
}